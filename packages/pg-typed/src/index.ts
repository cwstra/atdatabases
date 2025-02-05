import assertNever from 'assert-never';
import {SQLQuery, Queryable} from '@databases/pg';
import {
  bulkUpdate,
  bulkDelete,
  BulkOperationOptions,
  bulkCondition,
  bulkInsertStatement,
} from '@databases/pg-bulk';

const NO_RESULT_FOUND = `NO_RESULT_FOUND`;
const MULTIPLE_RESULTS_FOUND = `MULTIPLE_RESULTS_FOUND`;
export function isNoResultFoundError(
  err: unknown,
): err is Error & {code: typeof NO_RESULT_FOUND} {
  return (
    typeof err === 'object' &&
    err !== null &&
    err instanceof Error &&
    (err as any).code === NO_RESULT_FOUND
  );
}

export function isMultipleResultsFoundError(
  err: unknown,
): err is Error & {code: typeof MULTIPLE_RESULTS_FOUND} {
  return (
    typeof err === 'object' &&
    err !== null &&
    err instanceof Error &&
    (err as any).code === MULTIPLE_RESULTS_FOUND
  );
}

export interface DatabaseSchemaColumn {
  readonly name: string;
  readonly isNullable: boolean;
  readonly hasDefault: boolean;
  readonly typeId: number;
  readonly typeName: string | null;
}
export interface DatabaseSchemaTable {
  readonly name: string;
  readonly columns: readonly DatabaseSchemaColumn[];
}

export interface SelectQuery<TRecord> {
  one(): Promise<TRecord | null>;
  oneRequired(): Promise<TRecord>;
  all(): Promise<TRecord[]>;
  orderByAsc(key: keyof TRecord): OrderedSelectQuery<TRecord>;
  orderByDesc(key: keyof TRecord): OrderedSelectQuery<TRecord>;
  select<
    TKeys extends readonly [keyof TRecord, ...(readonly (keyof TRecord)[])],
  >(
    ...fields: TKeys
  ): SelectQuery<Pick<TRecord, TKeys[number]>>;
  andWhere(condition: WhereCondition<TRecord>): this;
}

export interface UnorderedSelectQuery<TRecord> extends SelectQuery<TRecord> {
  orderByAscDistinct(key: keyof TRecord): DistinctOrderedSelectQuery<TRecord>;
  orderByDescDistinct(key: keyof TRecord): DistinctOrderedSelectQuery<TRecord>;
}

export interface DistinctOrderedSelectQuery<TRecord>
  extends SelectQuery<TRecord> {
  orderByAscDistinct(key: keyof TRecord): DistinctOrderedSelectQuery<TRecord>;
  orderByDescDistinct(key: keyof TRecord): DistinctOrderedSelectQuery<TRecord>;
  first(): Promise<TRecord | null>;
  limit(count: number): Promise<TRecord[]>;
}

export interface OrderedSelectQuery<TRecord> extends SelectQuery<TRecord> {
  first(): Promise<TRecord | null>;
  limit(count: number): Promise<TRecord[]>;
}

type SpecialFieldQuery<T> =
  | {
      type: 'json_path';
      path: readonly string[];
      query: T | FieldQuery<T>;
    }
  | {type: 'case_insensitive'; query: T | FieldQuery<T>}
  | {type: 'not'; query: T | FieldQuery<T>};
class FieldQuery<T> {
  protected readonly __query: (
    columnName: SQLQuery,
    sql: Queryable['sql'],
    toValue: (value: unknown) => unknown,
  ) => SQLQuery;
  protected readonly __special: SpecialFieldQuery<T> | undefined;
  constructor(
    query: (
      columnName: SQLQuery,
      sql: Queryable['sql'],
      toValue: (value: unknown) => unknown,
    ) => SQLQuery,
    special?: SpecialFieldQuery<T>,
  ) {
    this.__query = query;
    this.__special = special;
  }
  protected __checkFieldType(): T {
    throw new Error(
      'This method is only there to help TypeScript interpret the type',
    );
  }
  static query<T>(
    columnName: SQLQuery,
    q: FieldQuery<T> | unknown,
    sql: Queryable['sql'],
    toValue: (value: unknown) => unknown,
  ): SQLQuery {
    if (q === null) {
      return sql`${columnName} IS NULL`;
    }
    if (q && q instanceof FieldQuery) {
      return q.__query(columnName, sql, toValue);
    }

    return sql`${columnName} = ${toValue(q)}`;
  }
  static getSpecial<T>(q: T | FieldQuery<T>) {
    if (q && q instanceof FieldQuery) {
      return q.__special;
    } else {
      return undefined;
    }
  }
}

const FALSE_FIELD_QUERY = new FieldQuery<any>((_columnName, sql) => sql`FALSE`);
const TRUE_FIELD_QUERY = new FieldQuery<any>((_columnName, sql) => sql`TRUE`);

export type {FieldQuery};

export function anyOf<T>(values: {
  [Symbol.iterator](): IterableIterator<T | FieldQuery<T>>;
}): T | FieldQuery<T> {
  const valuesSet = new Set<T>();
  const parts: FieldQuery<T>[] = [];
  const caseInsensitiveParts: (T | FieldQuery<T>)[] = [];
  const negatedParts: (T | FieldQuery<T>)[] = [];
  for (const value of values) {
    if (value === TRUE_FIELD_QUERY) {
      return TRUE_FIELD_QUERY;
    }
    if (value === FALSE_FIELD_QUERY) {
      continue;
    }
    if (value === null) {
      parts.push(
        new FieldQuery((columnName, sql, toValue) =>
          FieldQuery.query(columnName, null, sql, toValue),
        ),
      );
    } else if (value instanceof FieldQuery) {
      const special = FieldQuery.getSpecial(value);
      if (special?.type === 'case_insensitive') {
        caseInsensitiveParts.push(special.query);
      } else if (special?.type === 'not') {
        negatedParts.push(special.query);
      } else {
        parts.push(value);
      }
    } else {
      valuesSet.add(value);
    }
  }
  if (caseInsensitiveParts.length) {
    parts.push(caseInsensitive(anyOf(caseInsensitiveParts) as any) as any);
  }
  if (negatedParts.length) {
    const negated = not(allOf(negatedParts));
    if (negated && negated instanceof FieldQuery) {
      parts.push(negated);
    } else {
      valuesSet.add(negated);
    }
  }
  if (valuesSet.size) {
    if (valuesSet.size === 1 && parts.length === 0) {
      return [...valuesSet][0];
    }
    if (valuesSet.size === 1) {
      parts.push(
        new FieldQuery<T>((columnName, sql, toValue) =>
          FieldQuery.query(columnName, [...valuesSet][0], sql, toValue),
        ),
      );
    } else {
      parts.push(
        new FieldQuery<T>(
          (columnName, sql, toValue) =>
            sql`${columnName} = ANY(${[...valuesSet].map((v) => toValue(v))})`,
        ),
      );
    }
  }
  if (parts.length === 0) {
    return FALSE_FIELD_QUERY;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return new FieldQuery<T>(
    (columnName, sql, toValue) =>
      sql`(${sql.join(
        parts.map((p) => FieldQuery.query(columnName, p, sql, toValue)),
        ' OR ',
      )})`,
  );
}

export function allOf<T>(values: {
  [Symbol.iterator](): IterableIterator<T | FieldQuery<T>>;
}): T | FieldQuery<T> {
  const valuesSet = new Set<T>();
  const ordinaryParts: FieldQuery<T>[] = [];
  const negated: (T | FieldQuery<T>)[] = [];
  for (const q of values) {
    if (q === FALSE_FIELD_QUERY) {
      return FALSE_FIELD_QUERY;
    }
    if (q === TRUE_FIELD_QUERY) {
      continue;
    }
    if (q && q instanceof FieldQuery) {
      const special = FieldQuery.getSpecial(q);
      if (special?.type === 'not') {
        negated.push(special.query);
      } else {
        ordinaryParts.push(q);
      }
    } else {
      valuesSet.add(q);
    }
  }
  if (negated.length) {
    const n = not(anyOf(negated));
    if (n && n instanceof FieldQuery) {
      ordinaryParts.push(n);
    } else {
      valuesSet.add(n);
    }
  }
  if (valuesSet.size > 1) {
    return FALSE_FIELD_QUERY;
  } else if (valuesSet.size) {
    ordinaryParts.push(
      new FieldQuery((columnName, sql, toValue) =>
        FieldQuery.query(columnName, [...valuesSet][0], sql, toValue),
      ),
    );
  }
  if (ordinaryParts.length === 0) {
    return TRUE_FIELD_QUERY;
  }
  if (ordinaryParts.length === 1) {
    return ordinaryParts[0];
  }
  return new FieldQuery<T>(
    (columnName, sql, toValue) =>
      sql`(${sql.join(
        ordinaryParts.map((p) => FieldQuery.query(columnName, p, sql, toValue)),
        ' AND ',
      )})`,
  );
}

export function not<T>(value: T | FieldQuery<T>): T | FieldQuery<T> {
  if (value === TRUE_FIELD_QUERY) {
    return FALSE_FIELD_QUERY;
  } else if (value === FALSE_FIELD_QUERY) {
    return TRUE_FIELD_QUERY;
  }
  const special = FieldQuery.getSpecial(value);
  if (special?.type === 'not') {
    return special.query;
  }
  return new FieldQuery<T>(
    (columnName, sql, toValue) =>
      sql`NOT (${FieldQuery.query(columnName, value, sql, toValue)})`,
    {type: 'not', query: value},
  );
}

function internalInQueryResults(
  query: (sql: Queryable['sql']) => SQLQuery | FieldQuery<any>,
): FieldQuery<any> {
  return new FieldQuery<any>(
    (columnName, sql) => sql`${columnName} IN (${query(sql)})`,
  );
}

export function inQueryResults(query: SQLQuery): FieldQuery<any> {
  return internalInQueryResults(() => query);
}

export function lessThan<T>(value: T): FieldQuery<T> {
  return new FieldQuery<T>(
    (columnName, sql, toValue) => sql`${columnName} < ${toValue(value)}`,
  );
}

export function greaterThan<T>(value: T): FieldQuery<T> {
  return new FieldQuery<T>(
    (columnName, sql, toValue) => sql`${columnName} > ${toValue(value)}`,
  );
}

export function jsonPath(
  path: readonly string[],
  query: any | FieldQuery<any>,
): FieldQuery<any> {
  return new FieldQuery<any>(
    (columnName, sql, toValue) =>
      FieldQuery.query(sql`${columnName}#>${path}`, query, sql, toValue),
    {type: 'json_path', path, query},
  );
}

export function caseInsensitive(
  query: string | FieldQuery<string>,
): FieldQuery<string> {
  const special = FieldQuery.getSpecial(query);
  if (special?.type === 'json_path') {
    return jsonPath(special.path, caseInsensitive(special.query));
  }
  return new FieldQuery<string>(
    (columnName, sql, toValue) =>
      FieldQuery.query(
        sql`LOWER(CAST(${columnName} AS TEXT))`,
        query,
        sql,
        (v) => `${toValue(v)}`.toLowerCase(),
      ),
    {type: 'case_insensitive', query},
  );
}

class WhereCombinedCondition<TRecord> {
  protected readonly __conditions: readonly WhereCondition<TRecord>[];
  protected readonly __combiner: 'AND' | 'OR';
  constructor(
    conditions: readonly WhereCondition<TRecord>[],
    combiner: 'AND' | 'OR',
  ) {
    this.__conditions = conditions;
    this.__combiner = combiner;
  }
  static query<T>(
    q: WhereCombinedCondition<T> | WhereCondition<T>,
    sql: Queryable['sql'],
    toValue: (columnName: string, value: unknown) => unknown,
    parentType?: 'AND' | 'OR',
  ): SQLQuery | 'TRUE' | 'FALSE' {
    if (q instanceof WhereCombinedCondition) {
      const conditions = q.__conditions.map((c) =>
        WhereCombinedCondition.query(c, sql, toValue, q.__combiner),
      );
      const significantConditions: SQLQuery[] = [];
      switch (q.__combiner) {
        case 'AND': {
          for (const c of conditions) {
            if (c === 'FALSE') {
              return 'FALSE';
            } else if (c !== 'TRUE') {
              significantConditions.push(c);
            }
          }
          if (!significantConditions.length) {
            return 'TRUE';
          }
          if (significantConditions.length === 1) {
            return significantConditions[0];
          }
          const query = sql.join(significantConditions, sql` AND `);
          return parentType === 'OR' ? sql`(${query})` : query;
        }
        case 'OR': {
          for (const c of conditions) {
            if (c === 'TRUE') {
              return 'TRUE';
            } else if (c !== 'FALSE') {
              significantConditions.push(c);
            }
          }
          if (!significantConditions.length) {
            return 'FALSE';
          }
          if (significantConditions.length === 1) {
            return significantConditions[0];
          }
          const query = sql.join(significantConditions, sql` OR `);
          return parentType === 'AND' ? sql`(${query})` : query;
        }
        default:
          return assertNever(q.__combiner);
      }
    }

    const entries = Object.entries(q);
    const fieldTests: SQLQuery[] = [];
    for (const [columnName, value] of entries) {
      if (value === FALSE_FIELD_QUERY) {
        return 'FALSE';
      } else if (value !== TRUE_FIELD_QUERY) {
        fieldTests.push(
          FieldQuery.query(sql.ident(columnName), value, sql, (v) =>
            toValue(columnName, v),
          ),
        );
      }
    }
    if (fieldTests.length === 0) {
      return 'TRUE';
    }
    if (fieldTests.length === 1) {
      return fieldTests[0];
    }
    const query = sql.join(fieldTests, sql` AND `);
    return parentType === 'OR' ? sql`(${query})` : query;
  }
}
export type {WhereCombinedCondition};

export type WhereCondition<TRecord> =
  | Partial<
      {readonly [key in keyof TRecord]: TRecord[key] | FieldQuery<TRecord[key]>}
    >
  | WhereCombinedCondition<TRecord>;

export function and<TRecord>(
  ...conditions: readonly WhereCondition<TRecord>[]
): WhereCondition<TRecord> {
  return new WhereCombinedCondition(conditions, 'AND');
}
export function or<TRecord>(
  ...conditions: readonly WhereCondition<TRecord>[]
): WhereCondition<TRecord> {
  return new WhereCombinedCondition(conditions, 'OR');
}

interface SelectQueryOptions<TRecord> {
  readonly whereAnd: readonly WhereCondition<TRecord>[];
  readonly selectColumnNames: readonly string[] | undefined;
  readonly distinctColumnNames: readonly string[];
  readonly orderBy: readonly {
    readonly columnName: string;
    readonly direction: 'ASC' | 'DESC';
  }[];
  readonly limit: number | undefined;
}
class SelectQueryImplementation<TRecord>
  implements DistinctOrderedSelectQuery<TRecord>
{
  private readonly _distinctColumnNames: string[] = [];
  private readonly _orderByQueries: {
    columnName: string;
    direction: 'ASC' | 'DESC';
  }[] = [];
  private _limitCount: number | undefined;
  private _selectFields: readonly string[] | undefined;
  private readonly _whereAnd: WhereCondition<TRecord>[] = [];

  constructor(
    private readonly _tableName: string,
    public readonly _executeQuery: (
      options: SelectQueryOptions<TRecord>,
    ) => Promise<TRecord[]>,
  ) {}

  private _methodCalled: string | undefined;
  private async _getResults(mode: string) {
    if (this._methodCalled) {
      throw new Error(
        `You cannot use the same query multiple times. ${this._methodCalled} has already been called on this query.`,
      );
    }
    this._methodCalled = mode;

    return this._executeQuery({
      selectColumnNames: this._selectFields,
      orderBy: this._orderByQueries,
      limit: this._limitCount,
      distinctColumnNames: this._distinctColumnNames,
      whereAnd: this._whereAnd,
    });
  }

  public orderByAscDistinct(
    columnName: keyof TRecord,
  ): DistinctOrderedSelectQuery<TRecord> {
    if (this._distinctColumnNames.length !== this._orderByQueries.length) {
      throw new Error(`Cannot add distinct field after adding order by field`);
    }
    this._distinctColumnNames.push(columnName as string);
    this._orderByQueries.push({
      columnName: columnName as string,
      direction: `ASC`,
    });
    return this;
  }
  public orderByDescDistinct(
    columnName: keyof TRecord,
  ): DistinctOrderedSelectQuery<TRecord> {
    if (this._distinctColumnNames.length !== this._orderByQueries.length) {
      throw new Error(`Cannot add distinct field after adding order by field`);
    }
    this._distinctColumnNames.push(columnName as string);
    this._orderByQueries.push({
      columnName: columnName as string,
      direction: `DESC`,
    });
    return this;
  }
  public orderByAsc(columnName: keyof TRecord): OrderedSelectQuery<TRecord> {
    this._orderByQueries.push({
      columnName: columnName as string,
      direction: `ASC`,
    });
    return this;
  }
  public orderByDesc(columnName: keyof TRecord): OrderedSelectQuery<TRecord> {
    this._orderByQueries.push({
      columnName: columnName as string,
      direction: `DESC`,
    });
    return this;
  }

  public andWhere(condition: WhereCondition<TRecord>) {
    this._whereAnd.push(condition);
    return this;
  }

  public select<
    TKeys extends readonly [keyof TRecord, ...(readonly (keyof TRecord)[])],
  >(...fields: TKeys) {
    if (this._selectFields) {
      throw new Error('Cannot call select fields multiple times on one query');
    }
    this._selectFields = fields as readonly string[];
    return this;
  }

  public async all() {
    return await this._getResults('all');
  }
  public async limit(count: number) {
    if (!this._orderByQueries.length) {
      throw new Error(
        'You cannot call "limit" until after you call "orderByAsc" or "orderByDesc".',
      );
    }
    this._limitCount = count;
    return await this._getResults('limit');
  }
  public async first() {
    if (!this._orderByQueries.length) {
      throw new Error(
        'You cannot call "first" until after you call "orderByAsc" or "orderByDesc".',
      );
    }
    this._limitCount = 1;
    const results = await this._getResults('first');
    return results.length ? results[0] : null;
  }
  public async one() {
    const results = await this._getResults('only');
    if (results.length > 1) {
      throw Object.assign(
        new Error(
          `More than one row matched this query on ${this._tableName} but we only expected one.`,
        ),
        {code: MULTIPLE_RESULTS_FOUND},
      );
    }
    if (results.length === 0) {
      return null;
    }
    return results[0];
  }
  public async oneRequired() {
    const result = await this.one();
    if (result === null) {
      throw Object.assign(
        new Error(`No results matched this query on ${this._tableName}.`),
        {code: NO_RESULT_FOUND},
      );
    }
    return result;
  }
}

type BulkRecord<TParameters, TKey extends keyof TParameters> = {
  readonly [key in TKey]-?: Exclude<TParameters[key], undefined>;
} &
  {
    readonly [key in Exclude<keyof TParameters, TKey>]?: undefined;
  };

type BulkInsertFields<
  TInsertParameters,
  TKey extends keyof TInsertParameters,
> =
  | TKey
  | {
      readonly [K in keyof TInsertParameters]: undefined extends TInsertParameters[K]
        ? never
        : K;
    }[keyof TInsertParameters];

type BulkInsertRecord<
  TInsertParameters,
  TKey extends keyof TInsertParameters,
> = BulkRecord<TInsertParameters, BulkInsertFields<TInsertParameters, TKey>>;

type BulkOperationOptionsBase<
  TColumnName extends string | number | symbol,
  TInsertColumnName extends string | number | symbol,
> = Omit<BulkOperationOptions<TColumnName>, 'database'> & {
  requiredInsertColumnNames: readonly TInsertColumnName[];
};
function getBulkOperationOptionsBase<
  TColumnName extends string | number | symbol,
  TInsertColumnName extends string | number | symbol,
>(
  table: DatabaseSchemaTable,
  {
    sql,
    schemaName,
    serializeValue,
  }: {
    sql: Queryable['sql'];
    schemaName?: string;
    serializeValue: (column: string, value: unknown) => unknown;
  },
): BulkOperationOptionsBase<TColumnName, TInsertColumnName> {
  return {
    tableName: table.name,
    columnTypes: Object.fromEntries(
      table.columns.map((c) => [
        c.name,
        sql.__dangerous__rawValue(`${c.typeName}`),
      ]),
    ) as any,
    schemaName,
    serializeValue,
    requiredInsertColumnNames: table.columns
      .filter((c) => !c.isNullable && !c.hasDefault)
      .map((c) => c.name as TInsertColumnName),
  };
}
class Table<TRecord, TInsertParameters> {
  private readonly _value: (columnName: string, value: any) => unknown;
  private readonly _bulkOperationOptions:
    | (BulkOperationOptions<keyof TRecord | keyof TInsertParameters> & {
        requiredInsertColumnNames: readonly (keyof TInsertParameters)[];
      })
    | undefined;
  constructor(
    private readonly _underlyingDb: Queryable,
    public readonly tableId: SQLQuery,
    public readonly tableName: string,
    serializeValue: (columnName: string, value: unknown) => unknown,
    bulkOperationOptions:
      | (BulkOperationOptions<keyof TRecord | keyof TInsertParameters> & {
          requiredInsertColumnNames: readonly (keyof TInsertParameters)[];
        })
      | undefined,
  ) {
    this._value = (c, v) => serializeValue(c, v);
    this._bulkOperationOptions = bulkOperationOptions;
  }

  private _getBulkOperationOptions() {
    if (!this._bulkOperationOptions) {
      throw new Error(
        `You must provide a "databaseSchema" when constructing pg-typed to use bulk operations.`,
      );
    }
    return this._bulkOperationOptions;
  }

  async bulkInsert<
    TColumnsToInsert extends readonly [
      ...(readonly (keyof TInsertParameters)[])
    ],
  >({
    columnsToInsert,
    records,
  }: {
    readonly columnsToInsert: TColumnsToInsert;
    readonly records: readonly BulkInsertRecord<
      TInsertParameters,
      TColumnsToInsert[number]
    >[];
  }): Promise<TRecord[]> {
    if (records.length === 0) {
      return [];
    }
    const {sql} = this._underlyingDb;
    return await this._underlyingDb.query(
      sql`${bulkInsertStatement<keyof TInsertParameters>({
        ...this._getBulkOperationOptions(),
        columnsToInsert: [
          ...new Set([
            ...columnsToInsert,
            ...this._getBulkOperationOptions().requiredInsertColumnNames,
          ]),
        ].sort(),
        records,
      })} RETURNING ${this.tableId}.*`,
    );
  }

  async bulkInsertOrIgnore<
    TColumnsToInsert extends readonly [
      ...(readonly (keyof TInsertParameters)[])
    ],
  >({
    columnsToInsert,
    records,
  }: {
    readonly columnsToInsert: TColumnsToInsert;
    readonly records: readonly BulkInsertRecord<
      TInsertParameters,
      TColumnsToInsert[number]
    >[];
  }): Promise<TRecord[]> {
    if (records.length === 0) {
      return [];
    }
    const {sql} = this._underlyingDb;
    return await this._underlyingDb.query(
      sql`${bulkInsertStatement<keyof TInsertParameters>({
        ...this._getBulkOperationOptions(),
        columnsToInsert: [
          ...new Set([
            ...columnsToInsert,
            ...this._getBulkOperationOptions().requiredInsertColumnNames,
          ]),
        ].sort(),
        records,
      })} ON CONFLICT DO NOTHING RETURNING ${this.tableId}.*`,
    );
  }

  async bulkInsertOrUpdate<
    TColumnsToInsert extends readonly [
      ...(readonly (keyof TInsertParameters)[])
    ],
  >({
    columnsToInsert,
    columnsThatConflict,
    columnsToUpdate,
    records,
  }: {
    readonly columnsToInsert: TColumnsToInsert;
    readonly columnsThatConflict: readonly [
      TColumnsToInsert[number],
      ...TColumnsToInsert[number][]
    ];
    readonly columnsToUpdate: readonly [
      TColumnsToInsert[number],
      ...TColumnsToInsert[number][]
    ];
    readonly records: readonly BulkInsertRecord<
      TInsertParameters,
      TColumnsToInsert[number]
    >[];
  }): Promise<TRecord[]> {
    if (records.length === 0) {
      return [];
    }
    const {sql} = this._underlyingDb;
    return await this._underlyingDb.query(
      sql`${bulkInsertStatement<keyof TInsertParameters>({
        ...this._getBulkOperationOptions(),
        columnsToInsert: [
          ...new Set([
            ...columnsToInsert,
            ...this._getBulkOperationOptions().requiredInsertColumnNames,
          ]),
        ].sort(),
        records,
      })} ON CONFLICT (${sql.join(
        columnsThatConflict.map((k) => sql.ident(k)),
        sql`, `,
      )}) DO UPDATE SET ${sql.join(
        columnsToUpdate.map(
          (key) => sql`${sql.ident(key)}=EXCLUDED.${sql.ident(key)}`,
        ),
        sql`, `,
      )} RETURNING ${this.tableId}.*`,
    );
  }

  bulkFind<TWhereColumns extends readonly [...(readonly (keyof TRecord)[])]>({
    whereColumnNames,
    whereConditions,
  }: {
    readonly whereColumnNames: TWhereColumns;
    readonly whereConditions: readonly BulkRecord<
      TRecord,
      TWhereColumns[number]
    >[];
  }): UnorderedSelectQuery<TRecord> {
    const bulkOperationOptions = this._getBulkOperationOptions();
    return this._findUntyped(
      whereConditions.length
        ? bulkCondition({
            ...bulkOperationOptions,
            whereColumnNames,
            whereConditions,
          })
        : 'FALSE',
    );
  }

  async bulkUpdate<
    TWhereColumns extends readonly [...(readonly (keyof TRecord)[])],
    TSetColumns extends readonly [...(readonly (keyof TRecord)[])],
  >({
    whereColumnNames,
    setColumnNames,
    updates,
  }: {
    readonly whereColumnNames: TWhereColumns;
    readonly setColumnNames: TSetColumns;
    readonly updates: readonly {
      readonly where: BulkRecord<TRecord, TWhereColumns[number]>;
      readonly set: BulkRecord<TRecord, TSetColumns[number]>;
    }[];
  }): Promise<TRecord[]> {
    if (updates.length === 0) {
      return [];
    }
    const {sql} = this._underlyingDb;
    return await bulkUpdate<TWhereColumns[number], TSetColumns[number]>({
      ...this._getBulkOperationOptions(),
      whereColumnNames,
      setColumnNames,
      updates,
      returning: sql`${this.tableId}.*`,
    });
  }

  async bulkDelete<
    TWhereColumns extends readonly [...(readonly (keyof TRecord)[])],
  >({
    whereColumnNames,
    whereConditions,
  }: {
    readonly whereColumnNames: TWhereColumns;
    readonly whereConditions: readonly BulkRecord<
      TRecord,
      TWhereColumns[number]
    >[];
  }) {
    if (whereConditions.length === 0) {
      return;
    }
    await bulkDelete<TWhereColumns[number]>({
      ...this._getBulkOperationOptions(),
      whereColumnNames,
      whereConditions,
    });
  }

  private async _insert<TRecordsToInsert extends readonly TInsertParameters[]>(
    onConflict:
      | null
      | ((columnNames: Array<keyof TRecordsToInsert[number]>) => SQLQuery),
    ...rows: TRecordsToInsert
  ): Promise<TRecord[]> {
    if (rows.length === 0) return [];
    const {sql} = this._underlyingDb;

    const columnNamesSet = new Set<keyof TRecordsToInsert[number]>();
    for (const row of rows) {
      for (const columnName of Object.keys(row)) {
        columnNamesSet.add(columnName as keyof typeof row);
      }
    }
    const columnNames = [...columnNamesSet].sort();
    const columnNamesSql = sql.join(
      columnNames.map((columnName) => sql.ident(columnName)),
      sql`, `,
    );
    const values = rows.map(
      (row) =>
        sql`(${sql.join(
          columnNames.map((columnName) =>
            columnName in row
              ? sql.value(this._value(columnName as string, row[columnName]))
              : sql`DEFAULT`,
          ),
          `,`,
        )})`,
    );

    const results = await this._underlyingDb.query(
      onConflict
        ? sql`INSERT INTO ${this.tableId} (${columnNamesSql}) VALUES ${sql.join(
            values,
            `,`,
          )} ${onConflict(columnNames)} RETURNING *`
        : sql`INSERT INTO ${this.tableId} (${columnNamesSql}) VALUES ${sql.join(
            values,
            `,`,
          )} RETURNING *`,
    );
    return results;
  }

  async insert<TRecordsToInsert extends readonly TInsertParameters[]>(
    ...rows: keyof TRecordsToInsert[number] extends keyof TInsertParameters
      ? TRecordsToInsert
      : readonly ({
          readonly [key in keyof TInsertParameters]: TInsertParameters[key];
        } &
          {
            readonly [key in Exclude<
              keyof TRecordsToInsert[number],
              keyof TInsertParameters
            >]: never;
          })[]
  ): Promise<
    {
      -readonly [key in keyof TRecordsToInsert]: TRecord;
    }
  > {
    return this._insert(null, ...rows) as any;
  }

  async insertOrUpdate<TRecordsToInsert extends readonly TInsertParameters[]>(
    options:
      | readonly [keyof TRecord, ...(keyof TRecord)[]]
      | {
          onConflict: readonly [keyof TRecord, ...(keyof TRecord)[]];
          set?: readonly [keyof TRecord, ...(keyof TRecord)[]];
          doNotSet?: undefined;
        }
      | {
          onConflict: readonly [keyof TRecord, ...(keyof TRecord)[]];
          set?: undefined;
          doNotSet?: readonly [keyof TRecord, ...(keyof TRecord)[]];
        },
    ...rows: keyof TRecordsToInsert[number] extends keyof TInsertParameters
      ? TRecordsToInsert
      : readonly ({[key in keyof TInsertParameters]: TInsertParameters[key]} &
          {
            [key in Exclude<
              keyof TRecordsToInsert[number],
              keyof TInsertParameters
            >]: never;
          })[]
  ): Promise<{-readonly [key in keyof TRecordsToInsert]: TRecord}> {
    const getOption = (
      k: 'onConflict' | 'set' | 'doNotSet',
    ): readonly (keyof TRecord)[] | undefined => {
      return Array.isArray(options) ? undefined : (options as any)[k];
    };
    const conflictKeys =
      getOption('onConflict') ?? (options as readonly (keyof TRecord)[]);
    const set = getOption('set');
    const doNotSet = getOption('doNotSet');

    const {sql} = this._underlyingDb;
    return this._insert((columnNames) => {
      let updateKeys: readonly (string | number | symbol)[] = columnNames;
      if (set) {
        updateKeys = set;
      }
      if (doNotSet) {
        const keysNotToSet = new Set<string | number | symbol>(doNotSet);
        updateKeys = updateKeys.filter((key) => !keysNotToSet.has(key));
      }
      return sql`ON CONFLICT (${sql.join(
        conflictKeys.map((k) => sql.ident(k)),
        sql`, `,
      )}) DO UPDATE SET ${sql.join(
        updateKeys.map(
          (key) => sql`${sql.ident(key)}=EXCLUDED.${sql.ident(key)}`,
        ),
        sql`, `,
      )}`;
    }, ...rows) as any;
  }

  async insertOrIgnore<TRecordsToInsert extends readonly TInsertParameters[]>(
    ...rows: keyof TRecordsToInsert[number] extends keyof TInsertParameters
      ? TRecordsToInsert
      : readonly ({
          readonly [key in keyof TInsertParameters]: TInsertParameters[key];
        } &
          {
            readonly [key in Exclude<
              keyof TRecordsToInsert[number],
              keyof TInsertParameters
            >]: never;
          })[]
  ): Promise<TRecord[]> {
    const {sql} = this._underlyingDb;
    return await this._insert(() => sql`ON CONFLICT DO NOTHING`, ...rows);
  }

  async update(
    whereValues: WhereCondition<TRecord>,
    updateValues: Partial<TRecord>,
  ): Promise<TRecord[]> {
    const {sql} = this._underlyingDb;
    const whereConditions = WhereCombinedCondition.query(
      whereValues,
      sql,
      this._value,
    );
    if (whereConditions === `FALSE`) {
      return [];
    }
    const setClause = sql.join(
      Object.entries(updateValues).map(([columnName, value]) => {
        return sql`${sql.ident(columnName)} = ${this._value(
          columnName,
          value,
        )}`;
      }),
      sql`, `,
    );
    if (whereConditions === 'TRUE') {
      return await this.untypedQuery(
        sql`UPDATE ${this.tableId} SET ${setClause} RETURNING *`,
      );
    } else {
      return await this.untypedQuery(
        sql`UPDATE ${this.tableId} SET ${setClause} WHERE ${whereConditions} RETURNING *`,
      );
    }
  }

  async delete(whereValues: WhereCondition<TRecord>): Promise<void> {
    const {sql} = this._underlyingDb;
    const whereConditions = WhereCombinedCondition.query(
      whereValues,
      sql,
      this._value,
    );
    if (whereConditions === 'TRUE') {
      await this.untypedQuery(sql`DELETE FROM ${this.tableId}`);
    } else if (whereConditions !== 'FALSE') {
      await this.untypedQuery(
        sql`DELETE FROM ${this.tableId} WHERE ${whereConditions}`,
      );
    }
  }

  /**
   * @deprecated use .find instead of .select
   */
  select(
    whereValues: WhereCondition<TRecord> = {},
  ): UnorderedSelectQuery<TRecord> {
    return this.find(whereValues);
  }

  private _findUntyped(
    whereCondition: SQLQuery | 'TRUE' | 'FALSE',
  ): UnorderedSelectQuery<TRecord> {
    const {sql} = this._underlyingDb;
    return new SelectQueryImplementation(
      this.tableName,
      async ({
        selectColumnNames: selectFields,
        orderBy: orderByQueries,
        limit: limitCount,
        distinctColumnNames,
        whereAnd,
      }) => {
        const whereConditions = [
          whereCondition,
          ...whereAnd.map((c) =>
            WhereCombinedCondition.query(c, sql, this._value),
          ),
        ];

        const significantConditions: SQLQuery[] = [];
        for (const condition of whereConditions) {
          if (condition === 'FALSE') return [];
          else if (condition !== 'TRUE') significantConditions.push(condition);
        }

        return await this._underlyingDb.query(
          sql.join(
            [
              sql`SELECT`,
              distinctColumnNames.length
                ? sql`DISTINCT ON (${sql.join(
                    distinctColumnNames.map((f) => sql.ident(f)),
                    `,`,
                  )})`
                : null,
              selectFields
                ? sql.join(
                    selectFields.map((f) => sql.ident(f)),
                    ',',
                  )
                : sql`*`,
              sql`FROM ${this.tableId}`,
              significantConditions.length === 1
                ? sql`WHERE ${significantConditions[0]}`
                : significantConditions.length
                ? sql`WHERE (${sql.join(significantConditions, `) AND (`)})`
                : null,

              orderByQueries.length
                ? sql`ORDER BY ${sql.join(
                    orderByQueries.map((q) =>
                      q.direction === 'ASC'
                        ? sql`${sql.ident(q.columnName)} ASC`
                        : sql`${sql.ident(q.columnName)} DESC`,
                    ),
                    sql`, `,
                  )}`
                : null,
              limitCount ? sql`LIMIT ${limitCount}` : null,
            ].filter(<T>(v: T): v is Exclude<T, null> => v !== null),
            sql` `,
          ),
        );
      },
    );
  }

  find(
    whereValues: WhereCondition<TRecord> = {},
  ): UnorderedSelectQuery<TRecord> {
    const {sql} = this._underlyingDb;
    return this._findUntyped(
      WhereCombinedCondition.query(whereValues, sql, this._value),
    );
  }

  /**
   * @deprecated use .findOne instead of .selectOne
   */
  async selectOne(
    whereValues: WhereCondition<TRecord>,
  ): Promise<TRecord | null> {
    return this.findOne(whereValues);
  }
  // throws if > 1 row matches
  async findOne(whereValues: WhereCondition<TRecord>): Promise<TRecord | null> {
    return await this.find(whereValues).one();
  }
  async findOneRequired(
    whereValues: WhereCondition<TRecord>,
  ): Promise<TRecord> {
    return await this.find(whereValues).oneRequired();
  }

  async count(whereValues: WhereCondition<TRecord> = {}): Promise<number> {
    const {sql} = this._underlyingDb;
    const whereCondition = WhereCombinedCondition.query(
      whereValues,
      sql,
      this._value,
    );
    if (whereCondition === `FALSE`) {
      return 0;
    } else if (whereCondition === `TRUE`) {
      const [result] = await this._underlyingDb.query(
        sql`SELECT count(*) AS count FROM ${this.tableId}`,
      );
      return parseInt(result.count, 10);
    } else {
      const [result] = await this._underlyingDb.query(
        sql`SELECT count(*) AS count FROM ${this.tableId} WHERE ${whereCondition}`,
      );
      return parseInt(result.count, 10);
    }
  }

  async untypedQuery(query: SQLQuery): Promise<TRecord[]> {
    return await this._underlyingDb.query(query);
  }
}
export type {Table};

function getTable<TRecord, TInsertParameters>(
  tableName: string,
  defaultConnection: Queryable | undefined,
  schemaName: string | undefined,
  serializeValue: (columnName: string, value: unknown) => unknown,
  tableSchema?: DatabaseSchemaTable,
): TableHelper<TRecord, TInsertParameters> {
  const cache = new WeakMap<Queryable, Table<TRecord, TInsertParameters>>();
  const bulkOperationOptionsCache = new Map<
    Queryable['sql'],
    BulkOperationOptionsBase<
      keyof TRecord | keyof TInsertParameters,
      keyof TInsertParameters
    >
  >();
  return Object.assign(
    (
      queryable: Queryable | undefined = defaultConnection,
    ): Table<TRecord, TInsertParameters> => {
      if (!queryable) {
        throw new Error(
          'You must either provide a "defaultConnection" to pg-typed, or specify a connection when accessing the table.',
        );
      }
      const cached = cache.get(queryable);
      if (cached) return cached;

      let bulkOperationsBase = bulkOperationOptionsCache.get(queryable.sql);
      if (tableSchema && !bulkOperationsBase) {
        bulkOperationsBase =
          tableSchema &&
          getBulkOperationOptionsBase<
            keyof TRecord | keyof TInsertParameters,
            keyof TInsertParameters
          >(tableSchema, {
            sql: queryable.sql,
            schemaName,
            serializeValue,
          });
        bulkOperationOptionsCache.set(queryable.sql, bulkOperationsBase);
      }
      const fresh = new Table<TRecord, TInsertParameters>(
        queryable,
        schemaName
          ? queryable.sql.ident(schemaName, tableName)
          : queryable.sql.ident(tableName),
        tableName,
        serializeValue,
        bulkOperationsBase
          ? {...bulkOperationsBase, database: queryable}
          : undefined,
      );
      cache.set(queryable, fresh);

      return fresh;
    },
    {
      key: <TKey extends keyof TRecord>(
        fieldName: TKey,
        condition: WhereCondition<TRecord> = {},
      ): FieldQuery<TRecord[TKey]> =>
        internalInQueryResults((sql) => {
          const whereCondition = WhereCombinedCondition.query(
            condition,
            sql,
            serializeValue,
          );
          if (whereCondition === 'FALSE') {
            return FALSE_FIELD_QUERY;
          }
          const tableId = schemaName
            ? sql.ident(schemaName, tableName)
            : sql.ident(tableName);
          const fieldId = sql.ident(fieldName);
          if (whereCondition === 'TRUE') {
            return sql`SELECT ${fieldId} FROM ${tableId}`;
          } else {
            return sql`SELECT ${fieldId} FROM ${tableId} WHERE ${whereCondition}`;
          }
        }),
    },
  );
}

type TableHelperFunction<
  TMissingOptions extends keyof PgTypedOptions,
  TResult,
> = 'defaultConnection' extends TMissingOptions
  ? (connectionOrTransaction: Queryable) => TResult
  : (connectionOrTransaction?: Queryable) => TResult;

type AssertKeyOfTable<TKey extends keyof Table<any, any>> = TKey;
type PropertiesThatRequireDbSchema = AssertKeyOfTable<
  'bulkDelete' | 'bulkFind' | 'bulkInsert' | 'bulkUpdate'
>;
export type TableHelper<
  TRecord,
  TInsertParameters,
  TMissingOptions extends keyof PgTypedOptions = never,
> = {
  key: <TKey extends keyof TRecord>(
    fieldName: TKey,
    condition?: WhereCondition<TRecord>,
  ) => FieldQuery<TRecord[TKey]>;
} & TableHelperFunction<
  TMissingOptions,
  'databaseSchema' extends TMissingOptions
    ? Omit<Table<TRecord, TInsertParameters>, PropertiesThatRequireDbSchema>
    : Table<TRecord, TInsertParameters>
>;

export interface PgTypedOptions {
  schemaName?: string;
  serializeValue?: (
    tableName: string,
    columnName: string,
    value: unknown,
  ) => unknown;
  // TODO: easy aliasing of fields and easy parsing of fields using a similar API to the serializeValue?
  defaultConnection: Queryable;
  databaseSchema: DatabaseSchemaTable[];
}

export default function defineTables<TTables>(options: PgTypedOptions): {
  [TTableName in keyof TTables]: TableHelper<
    PropertyOf<TTables[TTableName], 'record'>,
    PropertyOf<TTables[TTableName], 'insert'>
  >;
};
export default function defineTables<TTables>(
  options: Omit<PgTypedOptions, 'defaultConnection'>,
): {
  [TTableName in keyof TTables]: TableHelper<
    PropertyOf<TTables[TTableName], 'record'>,
    PropertyOf<TTables[TTableName], 'insert'>,
    'defaultConnection'
  >;
};
export default function defineTables<TTables>(
  options: Omit<PgTypedOptions, 'databaseSchema'>,
): {
  [TTableName in keyof TTables]: TableHelper<
    PropertyOf<TTables[TTableName], 'record'>,
    PropertyOf<TTables[TTableName], 'insert'>,
    'databaseSchema'
  >;
};
export default function defineTables<TTables>(
  options?: Omit<PgTypedOptions, 'databaseSchema' | 'defaultConnection'>,
): {
  [TTableName in keyof TTables]: TableHelper<
    PropertyOf<TTables[TTableName], 'record'>,
    PropertyOf<TTables[TTableName], 'insert'>,
    'databaseSchema' | 'defaultConnection'
  >;
};
export default function defineTables<TTables>(
  options: Partial<PgTypedOptions> &
    Omit<PgTypedOptions, 'databaseSchema' | 'defaultConnection'> = {},
): {
  [TTableName in keyof TTables]: TableHelper<
    PropertyOf<TTables[TTableName], 'record'>,
    PropertyOf<TTables[TTableName], 'insert'>
  >;
} {
  if (options.databaseSchema) {
    return Object.fromEntries(
      options.databaseSchema.map((tableSchema) => [
        tableSchema.name,
        getTable(
          tableSchema.name,
          options.defaultConnection,
          options.schemaName,
          options.serializeValue
            ? (column: string, value: unknown) =>
                options.serializeValue!(tableSchema.name, column, value)
            : getTableSerializeValue(tableSchema),
          tableSchema,
        ),
      ]),
    ) as any;
  }
  return new Proxy(
    {},
    {
      get: (_target, prop, _receiver) => {
        if (prop === 'then') {
          return undefined;
        }
        const tableName = String(prop);
        return getTable(
          tableName,
          options.defaultConnection,
          options.schemaName,
          options.serializeValue
            ? (column: string, value: unknown) =>
                options.serializeValue!(tableName, column, value)
            : (_column: string, value: unknown) => value,
        );
      },
    },
  ) as any;
}

type PropertyOf<T, TProp extends string> = T extends {
  [k in TProp]: infer TValue;
}
  ? TValue
  : never;

function getTableSerializeValue(
  tableSchema: Pick<DatabaseSchemaTable, 'columns'>,
): (columnName: string, value: unknown) => unknown {
  const jsonColumns = new Set(
    tableSchema.columns
      .filter((c) => c.typeId === 114 || c.typeId === 3802)
      .map((c) => c.name),
  );
  const jsonArrayColumns = new Set(
    tableSchema.columns
      .filter((c) => c.typeId === 199 || c.typeId === 3807)
      .map((c) => c.name),
  );
  return tableSchema
    ? (columnName, value) => {
        if (jsonColumns.has(columnName)) {
          return JSON.stringify(value);
        }
        if (jsonArrayColumns.has(columnName) && Array.isArray(value)) {
          return value.map((v) => JSON.stringify(v));
        }
        return value;
      }
    : (_, value) => value;
}

module.exports = Object.assign(defineTables, {
  default: defineTables,
  anyOf,
  allOf,
  not,
  inQueryResults,
  lessThan,
  jsonPath,
  caseInsensitive,
  greaterThan,
  and,
  or,
  isNoResultFoundError,
  isMultipleResultsFoundError,
});
