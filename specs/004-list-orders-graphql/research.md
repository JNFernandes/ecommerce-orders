# Research: List Orders over GraphQL (US-06)

Phase 0 output for [plan.md](plan.md). Each entry records **Decision / Rationale / Alternatives**.
Versions and behaviour were verified in the installed tree:
- `@nestjs/graphql` 12.2.2, `@nestjs/apollo` 12.2.2, `@apollo/server` 4.13.0, `graphql` 16.14.2,
  `@nestjs/core` 10.4.22;
- `node_modules/@nestjs/apollo/dist/drivers/apollo-base.driver.js` and
  `node_modules/@apollo/server/dist/cjs/ApolloServer.js`.

---

## R1. Dependencies

**Decision**: No new runtime dependencies. The GraphQL stack is already installed (added with the
project skeleton) and compatible with NestJS 10. Apollo Server 4 ships the landing-page plugins
used in R3.

**Rationale**: Constitution tech-stack table: GraphQL = Apollo via `@nestjs/graphql`.

---

## R2. Where things live (layers, per the user's direction and Principles I/II)

**Decision**:

| Piece | Location | Layer |
|---|---|---|
| `OrdersResolver` | `src/controllers/orders.resolver.ts` | Controller: GraphQL I/O, args validation, maps read views to GraphQL types, dispatches **one query** |
| GraphQL types and args (`OrderType`, `OrderItemType`, `OrdersPageType`, `ListOrdersArgs`, the `OrderStatus` GraphQL enum registration) | `src/dto/graphql/` | DTO (request/response shapes, like the REST DTOs) |
| `ListOrdersQuery` | `src/queries/list-orders.query.ts` | Query object (mirrors `src/commands/`) |
| `ListOrdersService` (`@QueryHandler(ListOrdersQuery)`) | `src/services/list-orders.service.ts` | Service: calls the read repository, computes `hasNextPage` |
| `OrderViewRepository.list()` + `ensureIndexes()` | `src/read-model/order-view.repository.ts` | Repository (MongoDB) |
| Indexes | `src/read-model/order-view.schema.ts` (`OrderViewSchema.index(...)`) | Persistence |
| GraphQL module config, error filter, schema printer | `src/graphql/` | Infrastructure |

The flow is resolver → `QueryBus` → `ListOrdersService` → `OrderViewRepository` → MongoDB. The
resolver issues exactly one query and no command (Principle II). The GraphQL types are built from
`OrderView` (read model) only; nothing imports `src/domain/`, TypeORM entities, or write
repositories.

**Rationale**: This follows the user's direction (resolver in `src/controllers/`, handler in the
service layer, repository method in `src/read-model/`) and the existing layer-first naming
(`controllers/`, `commands/`, `services/`, `dto/`).

**Alternatives considered**: a self-contained `src/graphql/` vertical slice holding the resolver,
types and handler. It is tidy, but it breaks the layer-first convention used everywhere else in
the write path.

---

## R3. Apollo landing page and introspection outside / inside production

**Findings** (installed sources):
- When `playground` is undefined and `NODE_ENV !== 'production'`, `@nestjs/apollo` adds the
  **GraphQL Playground** plugin (deprecated), not the Apollo Sandbox.
- `playground: false` makes it add `ApolloServerPluginLandingPageDisabled`. That plugin is only an
  internal marker; it does not implement `renderLandingPage`. Apollo then skips its implicit
  default landing page.
- Apollo allows exactly one plugin implementing `renderLandingPage`.

**Decision**: `playground: false` always.
- **Not production**: `plugins: [ApolloServerPluginLandingPageLocalDefault({ embed: true })]`
  (Apollo Sandbox) and `introspection: true`.
- **Production** (`NODE_ENV=production`): no landing-page plugin (the disabled marker stays) and
  `introspection: false`.

This is driven by a new config value, `graphql.devTools = NODE_ENV !== 'production'`.

**Rationale**: FR-002. The spec explicitly asks for the Apollo sandbox. Apollo's
`includeStacktraceInErrorResponses` also defaults to off in production, so stack traces never
leak there.

**Alternatives considered**: keeping the Playground default (deprecated, and not what was asked).

---

## R4. Argument validation → `BAD_USER_INPUT`

**Findings**: the global `ValidationPipe` in `main.ts` also runs for GraphQL `@Args()` classes. It
throws `BadRequestException`, which `@nestjs/apollo` maps to code **`BAD_REQUEST`**. Only HTTP 422
maps to `BAD_USER_INPUT`.

**Decision**:
- `ListOrdersArgs` is an `@ArgsType()` class with:
  - `limit`: `@Field(() => Int, { defaultValue: 20 })`, `@Min(1) @Max(100)`;
  - `offset`: `@Field(() => Int, { defaultValue: 0 })`, `@Min(0)`;
  - `customerId`: `@IsOptional() @IsUUID()`;
  - `status`: `@IsOptional() @IsEnum(OrderViewStatus)`.
- A resolver-scoped exception filter, `GraphQLUserInputFilter` (`src/graphql/`), catches
  `BadRequestException` and rethrows a `UserInputError` (from `@nestjs/apollo`) with:
  - code `BAD_USER_INPUT`;
  - a message that joins the validation messages (e.g. `limit must not be greater than 100`);
  - `extensions.validationErrors` holding the message list.
- The global pipe setup moves into `configureApp(app)` (`src/app.setup.ts`), used by `main.ts` and
  by the new tests, so tests validate exactly as production does.
- An unknown `status` value never reaches the resolver: GraphQL enum coercion rejects it with
  `GRAPHQL_VALIDATION_FAILED` (or `BAD_USER_INPUT` when passed as a variable), and the message
  names the allowed values. That satisfies FR-010.

**Rationale**: This keeps the Constitution IV pattern (validation through a `class-validator` DTO
and Nest's built-in `ValidationPipe`, with errors mapped at the controller boundary) while giving
GraphQL clients the standard code.

**Alternatives considered**:
- a parameter-level `ValidationPipe` with an `exceptionFactory`: the global pipe runs first and
  throws before it, so it would be dead code;
- a global `formatError`: it would also rewrite REST-originated or unrelated `BadRequest`s.

---

## R5. Read model unavailable → clear GraphQL error

**Decision**: the same filter also catches `ReadModelUnavailableError` (already raised by
`OrderViewRepository`, US-05) and rethrows `GraphQLError('Order data is temporarily unavailable,
please retry', { extensions: { code: 'SERVICE_UNAVAILABLE' } })`, with no cause or connection
details. Anything else propagates as usual (Apollo hides stack traces in production).

**Rationale**: FR-011. The repository already classifies outages reliably, including the
Windows "Authentication failed." case found in US-05.

---

## R6. Query shape, sorting and paging in MongoDB

**Decision**: `OrderViewRepository.list({ status?, customerId? }, { limit, offset })`:
- `filter = { ...(status && { status }), ...(customerId && { customerId }) }`;
- `find(filter).sort({ placedAt: -1, _id: -1 }).skip(offset).limit(limit).lean()` and
  `countDocuments(filter)`, run in parallel;
- returns `{ views: OrderView[], totalCount }`.

The service computes `hasNextPage = offset + views.length < totalCount`.

In a descending sort MongoDB orders `null` lowest, so views without `placedAt` (created by an early
terminal event) come **last** with no special casing, as FR-006 requires. `_id` (the order id)
breaks ties deterministically, so pages never overlap or skip.

**Rationale**: This is the simplest query that meets FR-003–FR-007. Two reads (find and count)
may differ momentarily under concurrent projection; the spec accepts that.

**Alternatives considered**: an aggregation `$facet` (one round trip, but more complex and still
not transactional); cursor paging (out of scope).

---

## R7. Indexes and when they are created

**Decision**:
- Declared on the schema:
  - `{ customerId: 1, placedAt: -1, _id: -1 }` (name `customerId_placedAt`);
  - `{ status: 1, placedAt: -1, _id: -1 }` (name `status_placedAt`);
  - `{ placedAt: -1, _id: -1 }` (name `placedAt`), for the unfiltered list.

  These extend the requested `{customerId, placedAt}` / `{status, placedAt}` with `_id`, so the
  tie-breaking sort is fully index-backed.
- **Creation**: `autoIndex: false` on the connection. `OrderViewRepository.ensureIndexes()`
  (`model.createIndexes()`, idempotent) is called by `ReadModelConnectionMonitor` each time the
  connection is established.

**Rationale**: With the lazy connection and `bufferCommands: false` from US-05, Mongoose's
automatic index build at model compile time can run before any connection exists and fail
silently. Tying it to "connected" makes it deterministic, and it also covers a cold start with
MongoDB down. FR-014 and SC-005 are verified by an integration test that runs `explain()` and
asserts an `IXSCAN` on the expected index for each filter, which is deterministic, unlike a timing
test.

**Alternatives considered**: leaving `autoIndex` on (racy with lazy connections); a migration
script (no Mongo migration tooling in the project).

---

## R8. Schema file: code-first, in memory, committed SDL with a drift check

**Decision**:
- `GraphQLModule.forRootAsync({ driver: ApolloDriver, … autoSchemaFile: true, sortSchema: true })`,
  so the schema is generated in memory at startup and nothing is written at runtime (container
  file systems may be read-only).
- `src/graphql/print-schema.ts` exports `printOrdersSchema()`. It boots a minimal
  `GraphQLSchemaBuilderModule`, builds the schema from the resolver classes with
  `GraphQLSchemaFactory`, and returns `printSchema(lexicographicSortSchema(schema))`.
- `npm run schema:generate` (`ts-node scripts/generate-graphql-schema.ts`) writes
  `docs/schema.gql`.
- A unit test (`tests/unit/graphql/schema.spec.ts`) asserts that:
  - the committed `docs/schema.gql` equals `printOrdersSchema()` (drift check, FR-015);
  - every type, field, argument and enum value has a non-empty description (FR-009, SC-006).

**Rationale**: This follows the user's direction ("autoSchemaFile in memory and a generated
schema.gql committed under docs/"). The drift test makes the committed file trustworthy without
any runtime write.

**Alternatives considered**: `autoSchemaFile: 'docs/schema.gql'` (writes into the repository on
every start, including in production); a CI-only diff (no CI in the project yet).

---

## R9. Scalars

**Decision**:
- Dates use `@nestjs/graphql`'s default `DateTime` scalar (`dateScalarMode: 'isoDate'`), producing
  ISO-8601 strings.
- Money uses `Float`.
- `quantity`, `limit`, `offset` and `totalCount` use `Int`.
- The status enum is exposed as `OrderStatus`: `registerEnumType(OrderViewStatus, { name:
  'OrderStatus', valuesMap: { … descriptions } })`, using the **read-side** enum.

**Rationale**: This matches the REST and event formats (spec assumption) and keeps the read path
free of the write-side `OrderStatus`.

---

## R10. Testing approach

**Decision**:
- **Unit**:
  - `ListOrdersService`: passes filters and paging through, computes `hasNextPage` at the
    boundaries (empty, exact last page, partial page, offset past the end);
  - `ListOrdersArgs` validation table;
  - `GraphQLUserInputFilter`: `BadRequest` → `BAD_USER_INPUT` with messages; outage →
    `SERVICE_UNAVAILABLE` with no details; other errors pass through;
  - `OrdersResolver`: maps `OrderView` → `OrderType` without bookkeeping fields, and dispatches
    `ListOrdersQuery` only;
  - the schema drift and description test (R8).
- **Integration** (`tests/integration/list-orders.graphql.integration.spec.ts`): a
  `MongoDBContainer`, plus a Nest app with `GraphQLModule` (same config factory),
  `ReadModelModule`, `CqrsModule`, the resolver and the service, set up with `configureApp`. It
  seeds views through `OrderViewRepository` and sends **real** GraphQL HTTP requests with
  Supertest:
  - default page;
  - sort and tie-break;
  - each filter and both together;
  - paging consistency (walk all pages, compare with the full set);
  - offset past the end;
  - nullable fields for a view without `placedAt`;
  - every invalid argument (`BAD_USER_INPUT` or enum validation);
  - an `explain()` index check for each filter;
  - introspection allowed.

  A second app instance built with `NODE_ENV=production` checks that introspection is refused
  and no landing page is served.
- **Component** (`tests/component/list-orders.component.spec.ts`): real Kafka, PostgreSQL and
  MongoDB, plus the full module set (write path, projection, GraphQL). It places orders through
  REST, confirms one and cancels one, then polls the GraphQL `orders` query until all are
  visible with the right statuses, filters and `totalCount`.
- **Coverage**: the new service, resolver and filter fall under the existing `src/services`
  threshold or are added to `collectCoverageFrom` (`src/controllers/**/*.resolver.ts`,
  `src/graphql/**`).
