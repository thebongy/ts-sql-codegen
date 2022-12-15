import fs from "fs-extra";
import Handlebars from "handlebars";
import { register } from "hbs-dedent-helper";
import yaml from "js-yaml";
import path from "path/posix";
import { camelCase, memoize, upperFirst, last, isEmpty } from "lodash";
import { GeneratorOpts, GeneratorOptsSchema, NamingOptions, NamingOptionsSchema } from "./generator-options";
import {
  fieldMappings,
  GeneratedField,
  GeneratedFieldType,
  ImportedItem,
} from "./field-mappings";
import { Column, Table, TblsSchema } from "./tbls-types";
import { match } from "ts-pattern";

type Logger = Record<
  "debug" | "info" | "warn" | "error",
  (...args: any[]) => void
>;

register();

type ColumnMethod =
  | "column"
  | "optionalColumn"
  | "columnWithDefaultValue"
  | "optionalColumnWithDefaultValue"
  | "computedColumn"
  | "optionalComputedColumn"
  | "primaryKey"
  | "autogeneratedPrimaryKey";

interface FieldTmplInput {
  name: string;
  columnMethod: ColumnMethod;
  columnName: string;
  isOptional: boolean;
  hasDefault: boolean;
  fieldType: GeneratedFieldType;
  includeDBTypeWhenIsOptional: boolean;
}

interface ImportTmplInput {
  importPath: string;
  imported: string[];
  isDefault: boolean;
}

/**
 * Generator class for programmatic codegen.
 *
 * Most common usage involves creating an instance and calling generate function:
 *
 * ```ts
 * const options = {
 *    schemaPath: './schema.yaml',
 *    connectionSourcePath: './connection-source.ts'
 * }
 * const generator = new Generator(options);
 * await generator.generate();
 * ```
 *
 * See [GeneratorOpts](../interfaces/GeneratorOpts.md) for configuration options.
 *
 * For advanced use-cases, you can extend this class.
 * This enables you to use custom templates, pre/post processing of generated code
 * and custom logic for table/column/field mapping.
 */
export class Generator {
  protected opts: GeneratorOpts;
  protected naming: NamingOptions;
  public logger: Logger = console;

  constructor(opts: GeneratorOpts) {
    this.opts = GeneratorOptsSchema.parse(opts);
    this.naming = NamingOptionsSchema.parse(this.opts.naming || {});
  }

  protected getFieldMappings = memoize(() => {
    return (this.opts.fieldMappings ?? []).concat(fieldMappings);
  });

  protected getTemplatePath = memoize(() => {
    return path.join(__dirname, "template.ts.hbs");
  });

  protected getCompiledTemplate = memoize(async () => {
    const rawTemplate = await fs.readFile(this.getTemplatePath(), "utf8");
    return Handlebars.compile(rawTemplate);
  });

  async generate() {
    const rawSchema = await fs.readFile(
      path.resolve(this.opts.schemaPath),
      "utf8"
    );
    const schema = TblsSchema.parse(yaml.load(rawSchema));
    await Promise.all(
      schema.tables.map(async (table) => {
        if (this.shouldProcess(table)) {
          await this.generateTableMapper(table);
        }
      })
    );
  }

  protected shouldProcess(table: Table) {
    const filter = this.opts.tables;
    if (
      filter?.include &&
      filter.include.findIndex((it) =>
        doesMatchNameOrPattern(it, table.name)
      ) < 0
    ) {
      return false;
    }
    if (
      filter?.exclude &&
      filter.exclude.findIndex((it) =>
        doesMatchNameOrPattern(it, table.name)
      ) >= 0
    ) {
      return false;
    }
    return true;
  }

  protected getTableKind(table: Table): TableKind | null {
    return match(table.type.toLowerCase())
      .with("base table", () => "Table" as const)
      .with("table", () => "Table" as const)
      .with("view", () => "View" as const)
      .otherwise(() => null);
  }

  protected async generateTableMapper(table: Table) {
    // Qualified table name with schema prefix
    const tableName = last(table.name.split(".")) as string;
    const tableKind = this.getTableKind(table);
    if (!tableKind) {
      this.logger.warn(
        `Unknown table type ${table.type} for table ${table.name}: SKIPPING`
      );
      return;
    }
    const pkCol = this.findPrimaryKey(table);
    const fields: FieldTmplInput[] = table.columns
      .filter((col) => {
        return !this.isColumnOmitted(table.name, col);
      })
      .map((col) => {
        const isOptional = this.isColumnOptional(table.name, col);
        const hasDefault = this.doesColumnHaveDefault(table.name, col);
        const isComputed = this.isColumnComputed(table.name, col);
        let columnMethod!: ColumnMethod;
        if (col === pkCol) {
          let isAutoGenerated =
            col.default ??
            this.opts.common?.primaryKey?.isAutoGenerated ??
            false;
          columnMethod = isAutoGenerated
            ? "autogeneratedPrimaryKey"
            : "primaryKey";
        } else if (isComputed) {
          if (isOptional) {
            columnMethod = "optionalComputedColumn";
          } else {
            columnMethod = "computedColumn";
          }
        } else if (!isOptional && !hasDefault) {
          columnMethod = "column";
        } else if (isOptional && !hasDefault) {
          columnMethod = "optionalColumn";
        } else if (isOptional && hasDefault) {
          columnMethod = "optionalColumnWithDefaultValue";
        } else if (!isOptional && hasDefault) {
          columnMethod = "columnWithDefaultValue";
        }
        return {
          name: this.getFieldNameForColumn(table.name, col),
          columnName: col.name,
          comment: this.formatComment(col.comment),
          isOptional,
          hasDefault,
          columnMethod,
          fieldType: this.getFieldType(table.name, col),
          includeDBTypeWhenIsOptional: this.opts.includeDBTypeWhenIsOptional || false,
        };
      });
    const filePath = this.getOutputFilePath(table, tableKind);
    const dbConnectionSource = this.getConnectionSourceImportPath(filePath);
    const adapterImports = this.getAdapterImports(filePath, fields);
    const typeImports = this.getTypeImports(filePath, fields);
    const imports = [...adapterImports, ...typeImports];
    const exportTableClass = this.opts.export?.tableClasses ?? true;
    const exportRowTypes = this.opts.export?.rowTypes ? ({} as any) : false;
    const pascalName = this.getPascalCasedTableName(tableName);
    if (exportRowTypes !== false) {
      exportRowTypes.selected = this.naming.selectedRowTypeNamePrefix + pascalName + this.naming.selectedRowTypeNameSuffix;
      if (tableKind !== "View") {
        exportRowTypes.insertable = this.naming.insertableRowTypeNamePrefix + pascalName + this.naming.insertableRowTypeNameSuffix;
        exportRowTypes.updatable = this.naming.updatableRowTypeNamePrefix + pascalName + this.naming.updatableRowTypeNameSuffix;
      }
    }
    const exportValuesTypes = this.opts.export?.valuesTypes ? ({} as any) : false;
    if (exportValuesTypes !== false) {
      exportValuesTypes.selected = this.naming.selectedValuesTypeNamePrefix + pascalName + this.naming.selectedValuesTypeNameSuffix;
      if (tableKind !== "View") {
        exportValuesTypes.insertable = this.naming.insertableValuesTypeNamePrefix + pascalName + this.naming.insertableValuesTypeNameSuffix;
        exportValuesTypes.updatable = this.naming.updatableValuesTypeNamePrefix + pascalName + this.naming.updatableValuesTypeNameSuffix;
      }
    }
    const className = this.getClassNameFromTableName(table.name, tableKind);
    const colSetName = this.opts.export?.extractedColumns
      ? this.getColumnsObjectNameFromTableName(table.name, tableKind)
      : null;
    const instName =
      this.opts.export?.tableInstances || colSetName
        ? this.getInstanceNameFromTableName(table.name, tableKind)
        : null;
    const idPrefix = this.getIdPrefix(table);
    const rowTypePrefix = this.getRowTypePrefix(tableName);
    const templateInput = await this.preProcessTemplateInput({
      table: {
        name: this.opts.tableMapping?.useQualifiedTableName
          ? table.name
          : tableName,
        kind: tableKind,
        comment: this.formatComment(table.comment),
        idPrefix,
      },
      imports,
      dbConnectionSource,
      className,
      instName,
      fields,
      adapterImports,
      exportTableClass,
      exportRowTypes,
      exportValuesTypes,
      importExtraTypes: exportRowTypes || exportValuesTypes,
      rowTypePrefix,
      colSetName,
    });
    const template = await this.getCompiledTemplate();
    const output = await this.postProcessOutput(template(templateInput), table);
    await fs.ensureDir(path.dirname(filePath));
    if (this.opts.dryRun) {
      this.logger.info(`Will populate ${filePath} with:`);
      this.logger.info(output);
      this.logger.info("---");
    } else {
      this.logger.info(`Writing ${filePath}`);
      await fs.writeFile(filePath, output);
    }
  }

  protected getIdPrefix(table: Table) {
    let idPrefix = this.opts.tableMapping?.idPrefix;
    if (!idPrefix && this.opts.tableMapping?.useQualifiedTableName) {
      idPrefix = table.name
        .split(".")
        .slice(0, -1)
        .map((it) => upperFirst(camelCase(it)))
        .join("");
    }
    return idPrefix;
  }

  protected formatComment(comment: string | null | undefined) {
    if (isEmpty(comment)) return null;
    return (
      "/**\n" +
      comment!
        .split("\n")
        .map((it) => ` * ${it}`)
        .join("\n") +
      "\n*/"
    );
  }

  protected getConnectionSourceImportPath(outputFilePath: string) {
    const relPath = path.relative(
      path.dirname(outputFilePath),
      path.resolve(this.opts.connectionSourcePath)
    );
    return path.join(
      path.dirname(relPath),
      path.basename(relPath)
    );
  }

  protected getAdapterImports(
    outputFilePath: string,
    fields: FieldTmplInput[]
  ): ImportTmplInput[] {
    const imports = new Map<string, Set<string>>();
    const defaultImports = new Map<string, Set<string>>();
    for (const field of fields) {
      const adapter = field.fieldType?.adapter;
      if (!adapter) continue;
      const importPath = this.getAdapterImportPath(adapter, outputFilePath);
      let adapterImports;
      const map = adapter.isDefault ? defaultImports : imports;
      adapterImports = map.get(importPath) ?? new Set<string>();
      map.set(importPath, adapterImports);
      adapterImports.add(adapter.name);
    }
    return this.accumulateImports(imports, defaultImports);
  }

  private accumulateImports(
    imports: Map<string, Set<string>>,
    defaultImports: Map<string, Set<string>>
  ) {
    const inputs: ImportTmplInput[] = [];
    for (const [entries, isDefault] of [
      [imports.entries(), false],
      [defaultImports.entries(), true],
    ] as const) {
      for (const [importPath, importedSet] of entries) {
        inputs.push({
          importPath,
          imported: [...importedSet],
          isDefault,
        });
      }
    }
    return inputs;
  }

  protected getTypeImports(
    outputFilePath: string,
    fields: FieldTmplInput[]
  ): ImportTmplInput[] {
    const imports = new Map<string, Set<string>>();
    const defaultImports = new Map<string, Set<string>>();
    for (const field of fields) {
      const tsType = field.fieldType.tsType;
      if (!tsType) continue;
      const importPath = tsType.importPath;
      const name = tsType.name;
      if (!importPath || !name) {
        continue;
      }
      const nImportPath = this.getImportPathForOutputPath(
        outputFilePath,
        importPath,
        tsType
      );
      const map = tsType.isDefault ? defaultImports : imports;
      const typeImports = map.get(nImportPath) ?? new Set<string>();
      map.set(nImportPath, typeImports);
      typeImports.add(name);
    }
    return this.accumulateImports(imports, defaultImports);
  }

  protected getImportPathForOutputPath(
    filePath: string,
    importPath: string,
    importedItem: ImportedItem
  ) {
    if (importedItem.isRelative === false) return importPath;
    const result: string = path.relative(path.dirname(filePath), path.resolve(importPath));
    if (result.startsWith(".")) {
      return result;
    } else {
      return "./" + result;
    }
  }

  protected getAdapterImportPath(
    adapter: ImportedItem,
    outputFilePath: string
  ) {
    const relImportPath =
      adapter.importPath ?? this.opts.common?.typeAdapter?.importPath;
    if (!relImportPath) {
      throw new Error(
        `Unable to resolve import path for type adapter: ${JSON.stringify(
          adapter
        )}`
      );
    }
    return this.getImportPathForOutputPath(
      outputFilePath,
      relImportPath,
      adapter
    );
  }

  protected async preProcessTemplateInput(input: any) {
    return input;
  }

  protected async postProcessOutput(output: string, _table: Table) {
    return output;
  }

  protected getClassNameFromTableName(tableName: string, tableKind: TableKind) {
    if (tableKind === 'Table') {
      return this.naming.tableClassNamePrefix + this.getPascalCasedTableName(tableName) + this.naming.tableClassNameSuffix;
    } else {
      return this.naming.viewClassNamePrefix + this.getPascalCasedTableName(tableName) + this.naming.viewClassNameSuffix;
    }
  }

  protected getRowTypePrefix(tableName: string) {
    return this.getPascalCasedTableName(tableName);
  }

  protected getInstanceNameFromTableName(tableName: string, tableKind: TableKind) {
    if (tableKind === 'Table') {
      return this.naming.tableInstanceNamePrefix + this.getPascalCasedTableName(tableName) + this.naming.tableInstanceNameSuffix;
    } else {
      return this.naming.viewInstanceNamePrefix + this.getPascalCasedTableName(tableName) + this.naming.viewInstanceNameSuffix;
    }
  }

  protected getColumnsObjectNameFromTableName(tableName: string, tableKind: TableKind) {
    if (tableKind === 'Table') {
      if (this.naming.tableColumnsNamePrefix) {
        return this.naming.tableColumnsNamePrefix + this.getPascalCasedTableName(tableName) + this.naming.tableColumnsNameSuffix;
      } else {
        return this.getCamelCasedTableName(tableName) + this.naming.tableColumnsNameSuffix;
      }
    } else {
      if (this.naming.viewColumnsNamePrefix) {
        return this.naming.viewColumnsNamePrefix + this.getPascalCasedTableName(tableName) + this.naming.viewColumnsNameSuffix;
      } else {
        return this.getCamelCasedTableName(tableName) + this.naming.viewColumnsNameSuffix;
      }
    }
  }

  private getPascalCasedTableName(tableName: string) {
    return upperFirst(camelCase(last(tableName.split("."))));
  }

  private getCamelCasedTableName(tableName: string) {
    return camelCase(last(tableName.split(".")));
  }

  protected isColumnOmitted(tableName: string, col: Column) {
    const mapping = this.getFieldMappings().find(
      (it) =>
        it.generatedField === false &&
        doesMatchNameOrPattern(it.columnName, col.name) &&
        doesMatchNameOrPattern(it.tableName, tableName) &&
        doesMatchNameOrPattern(it.columnType, col.type)
    );
    return !!mapping;
  }

  protected isColumnOptional(tableName: string, col: Column): boolean {
    const mapping = this.getFieldMappings().find(
      (it) =>
        it.generatedField &&
        it.generatedField.isOptional != null &&
        doesMatchNameOrPattern(it.columnName, col.name) &&
        doesMatchNameOrPattern(it.tableName, tableName) &&
        doesMatchNameOrPattern(it.columnType, col.type)
    );
    if (mapping?.generatedField) {
      return mapping.generatedField.isOptional === true;
    } else {
      return col.nullable === true;
    }
  }

  protected doesColumnHaveDefault(tableName: string, col: Column): boolean {
    const mapping = this.getFieldMappings().find(
      (it) =>
        it.generatedField &&
        it.generatedField.hasDefault != null &&
        doesMatchNameOrPattern(it.columnName, col.name) &&
        doesMatchNameOrPattern(it.tableName, tableName) &&
        doesMatchNameOrPattern(it.columnType, col.type)
    );
    if (mapping?.generatedField) {
      return mapping.generatedField.hasDefault === true;
    } else {
      return col.default != null;
    }
  }

  protected isColumnComputed(tableName: string, col: Column): boolean {
    const mapping = this.getFieldMappings().find(
      (it) =>
        it.generatedField &&
        it.generatedField.isComputed != null &&
        doesMatchNameOrPattern(it.columnName, col.name) &&
        doesMatchNameOrPattern(it.tableName, tableName) &&
        doesMatchNameOrPattern(it.columnType, col.type)
    );
    if (mapping?.generatedField) {
      return mapping.generatedField.isComputed === true;
    }
    return false;
  }

  protected getFieldNameForColumn(tableName: string, col: Column) {
    const mapping = this.getFieldMappings().find(
      (it) =>
        it.generatedField &&
        it.generatedField?.name &&
        doesMatchNameOrPattern(it.columnName, col.name) &&
        doesMatchNameOrPattern(it.tableName, tableName) &&
        doesMatchNameOrPattern(it.columnType, col.type)
    );
    return (
      (mapping?.generatedField as GeneratedField)?.name ?? camelCase(col.name)
    );
  }

  protected getFieldType(tableName: string, col: Column): GeneratedFieldType {
    const mapping = this.getFieldMappings().find(
      (it) =>
        it.generatedField &&
        it.generatedField?.type &&
        doesMatchNameOrPattern(it.columnName, col.name) &&
        doesMatchNameOrPattern(it.tableName, tableName) &&
        doesMatchNameOrPattern(it.columnType, col.type)
    );
    if (!mapping) {
      throw new Error(
        `Failed to infer field type for ${tableName}.${col.name}`
      );
    }
    const generatedField = mapping.generatedField as GeneratedField;
    const dbTypeName = generatedField.type?.dbType?.name ?? col.type;
    let tsTypeName = generatedField.type?.tsType?.name;
    if (generatedField?.type?.adapter && !tsTypeName) {
      tsTypeName = upperFirst(camelCase(dbTypeName));
    }
    return {
      ...generatedField.type,
      dbType: {
        ...generatedField.type?.dbType,
        name: dbTypeName,
      },
      tsType: {
        ...generatedField.type?.tsType,
        name: tsTypeName ?? "unknown",
      },
    };
  }

  protected getOutputFilePath(table: Table, tableKind: TableKind) {
    const fileName = this.getOutputFileName(table, tableKind);
    return path.join(this.opts.outputDirPath, fileName);
  }

  protected getOutputFileName(table: Table, tableKind: TableKind) {
    return this.getClassNameFromTableName(table.name, tableKind) + ".ts";
  }

  protected findPrimaryKey(table: Table) {
    let col: Column | null = null;
    const commonPKColName = this.opts.common?.primaryKey?.name;
    if (commonPKColName) {
      col = table.columns.find((it) => it.name === commonPKColName) ?? null;
    }
    if (!col) {
      const pkConstraint = table.constraints.find(
        (it) => it.type === "PRIMARY KEY"
      );
      if (pkConstraint && pkConstraint.columns.length === 1) {
        return table.columns.find((it) => it.name === pkConstraint.columns[0]);
      }
    }
    return null;
  }
}

const doesMatchNameOrPattern = (
  matcher: undefined | null | string | RegExp,
  target: string
) => {
  if (matcher == null) return true;
  if (typeof matcher === "string") {
    const matcherParts = matcher.split(".");
    const targetParts = target.split(".");
    for (let i = 0; i < matcherParts.length; i++) {
      if (
        targetParts[targetParts.length - 1 - i] !==
        matcherParts[matcherParts.length - 1 - i]
      ) {
        return false;
      }
    }
    return true;
  }
  return target.match(matcher);
};

type TableKind = "Table" | "View"