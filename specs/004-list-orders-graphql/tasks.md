---

description: "Task list for US-06 List Orders over GraphQL"
---

# Tasks: List Orders over GraphQL (US-06)

**Input**: Design documents from `specs/004-list-orders-graphql/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R10), data-model.md,
contracts/graphql-orders-query.md, quickstart.md

**Tests**: REQUIRED by the user's description and constitution Principles V/VI:
- unit tests for the query handler and the other new units;
- integration tests running **real GraphQL queries** against the app with a MongoDB container;
- a full-stack component test.

Within each story, write the tests first and confirm they fail before implementing.

**Organization**: by the four user stories in spec.md:

- **US1** Browse recent orders, a page at a time (P1)
- **US2** Filter by status and customer (P1)
- **US3** Clear errors for invalid requests (P2)
- **US4** Discover the API (P3)

**Quality gate (Constitution IX)**: after **every** task, run `npm run build && npm run lint &&
npm run format:check && npm run test`, and fix any failure before moving on. Commit per phase
with Conventional Commits scoped `US-06`.

**Read path rule (Principle II, FR-012/013)**: nothing added under `src/controllers/orders.resolver.ts`,
`src/dto/graphql/`, `src/queries/`, `src/services/list-orders.service.ts` or `src/graphql/` may import
from `src/domain/`, `src/infra/database/`, `src/repositories/` or `src/commands/`. The resolver
dispatches only `ListOrdersQuery` and never touches the `CommandBus`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 (setup, foundational and polish tasks have no label)

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Add `GraphqlConfig { devTools: boolean }` to `src/config/configuration.ts` (`graphql.devTools = process.env.NODE_ENV !== 'production'`), with JSDoc, and add `graphql` to `AppConfig`.
- [X] T002 Create `configureApp(app: INestApplication): void` in `src/app.setup.ts`. Move the global `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })` there from `src/main.ts`, and call it from `main.ts`. Behaviour is unchanged, and the existing tests (which set the pipe inline) stay untouched.
- [X] T003 [P] In `jest.config.js`, add `src/controllers/**/*.resolver.ts` and `src/graphql/**/*.ts` (excluding `src/graphql/print-schema.ts`, which is tooling) to `collectCoverageFrom`, with an 80% threshold entry for each glob.

**Checkpoint**: build and tests are green, with no behaviour change.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: read-model indexes and the GraphQL types every story returns.

**⚠️ CRITICAL**: no user-story work begins until this phase is complete.

### Tests first

- [X] T004 [P] Extend `tests/unit/read-model/read-model-connection.spec.ts`:
  - on a successful initial connect, `ReadModelConnectionMonitor` calls `OrderViewRepository.ensureIndexes()` once;
  - after a failed connect followed by a successful `openUri`, it calls it once;
  - if `ensureIndexes` rejects, it logs a warning and does not crash.

  Inject a mocked repository.
- [X] T005 [P] Extend `tests/integration/order-view.repository.integration.spec.ts`. After `ensureIndexes()`, `collection.listIndexes()` contains `customerId_placedAt` (`{customerId:1, placedAt:-1, _id:-1}`), `status_placedAt` (`{status:1, placedAt:-1, _id:-1}`) and `placedAt` (`{placedAt:-1, _id:-1}`). A second call is a no-op and does not throw.

### Implementation

- [X] T006 Declare the three indexes in `src/read-model/order-view.schema.ts`, using `OrderViewSchema.index(keys, { name })` exactly as in data-model.md.
- [X] T007 Add `ensureIndexes(): Promise<void>` (`model.createIndexes()`, wrapped by the existing `guard`) to `src/read-model/order-view.repository.ts`. Set `autoIndex: false` in the `MongooseModule.forRootAsync` options in `src/read-model/read-model.module.ts`, and in `tests/integration/support/read-model-testing.ts`. Makes T005 pass.
- [X] T008 In `src/read-model/read-model-connection.ts`, inject `OrderViewRepository` into `ReadModelConnectionMonitor`. On every successful connect, call `ensureIndexes()`, catching and logging a warning on failure. Update `tests/unit/read-model/read-model-connection.spec.ts`'s construction for the new constructor argument. Makes T004 pass.
- [X] T009 [P] Create the GraphQL output types in `src/dto/graphql/`, with a `description` on **every** type, field and enum value. Each file may import only from `src/read-model/` (never `src/domain/`).
  - `order-status.enum.ts`: `registerEnumType(OrderViewStatus, { name: 'OrderStatus', description, valuesMap: { PENDING: { description }, CONFIRMED: {…}, CANCELLED: {…} } })`.
  - `order-item.type.ts`: `@ObjectType('OrderItem')` with `productId: String!`, `quantity: Int!`, `unitPrice: Float!`, `subtotal: Float!`.
  - `order.type.ts`: `@ObjectType('Order')` with the fields and nullability from data-model.md, plus `static fromView(view: OrderView): OrderType`. It copies only the exposed fields and never `appliedEventIds`, `statusEventId`, `revision` or `updatedAt`.
  - `orders-page.type.ts`: `@ObjectType('OrdersPage')` with `items: [Order!]!`, `totalCount: Int!`, `hasNextPage: Boolean!`.
- [X] T010 [P] Unit test `tests/unit/dto/order.type.spec.ts`. `OrderType.fromView` maps every field of a complete `CONFIRMED` view and of a view with `items`/`totalAmount`/`placedAt` `null`. The result has exactly the exposed keys (no bookkeeping fields).

**Checkpoint**: indexes are created on connect, and the GraphQL types exist (not served yet).

---

## Phase 3: User Story 1 — Browse recent orders, a page at a time (Priority: P1) 🎯 MVP

**Goal**: `POST /graphql` with `{ orders(limit, offset) { … } }` returns orders newest first (ties by `orderId` desc, `placedAt` null last), with `totalCount` and `hasNextPage`, read from MongoDB through the `QueryBus`.

**Independent Test**: seed 5 views and query `orders(limit: 2)`, then `offset: 2` and `offset: 4`. The concatenated pages equal the full sorted list. `totalCount` is 5, and `hasNextPage` is true, true, false.

### Tests (write first)

- [X] T011 [P] [US1] Unit tests in `tests/unit/services/list-orders.service.spec.ts` (mock `OrderViewRepository.list`):
  - `filter` and `page` are passed through unchanged;
  - `hasNextPage` for: an empty result (total 0); an exact last page (offset 4, 1 item, total 5 → false); a partial page with more left (offset 0, 2 items, total 5 → true); an offset beyond the end (offset 10, 0 items, total 5 → false);
  - repository errors propagate.
- [X] T012 [P] [US1] Unit tests in `tests/unit/controllers/orders.resolver.spec.ts` (mock `QueryBus`):
  - `orders(args)` executes exactly one `ListOrdersQuery` with `{ status, customerId }` and `{ limit, offset }` from the args;
  - it maps the result to `OrdersPageType` through `OrderType.fromView`, so bookkeeping fields are absent;
  - the resolver has no `CommandBus` dependency (assert the constructor parameter metadata or `Object.keys` of its injected deps).
- [X] T013 [US1] Integration test in `tests/integration/list-orders.graphql.integration.spec.ts`:
  - **Setup**: `MongoDBContainer('mongo:7')`. Build the testing module with `ConfigModule` (configuration), `CqrsModule.forRoot()`, `GraphQLModule.forRootAsync` using the **same** options factory as the app (`src/graphql/graphql.config.ts`), and a `ReadModelModule`-equivalent (Mongoose to the container plus `OrderViewRepository`), plus `OrdersResolver` and `ListOrdersService`. Call `configureApp(app)` and `ensureIndexes()`. Seed views with `OrderViewRepository.insert`. Add a `gql(query, variables?)` helper posting to `/graphql` with Supertest.
  - **US1 cases**: the default call returns ≤ 20 items newest first, with correct `totalCount`; ties on `placedAt` are ordered by `orderId` desc; a view with `placedAt: null` comes last with `items`/`totalAmount`/`placedAt` null; paging `limit: 2` across all pages yields every order exactly once; `hasNextPage` is correct on each page; an offset past the end gives empty `items` with the correct `totalCount`; every exposed field round-trips (dates as ISO strings); bookkeeping fields are not queryable (asking for `revision` gives `GRAPHQL_VALIDATION_FAILED`).
- [X] T014 [US1] Component test in `tests/component/list-orders.component.spec.ts`:
  - **Setup**: real PostgreSQL, Kafka (create the `orders.*` topics) and MongoDB containers. Module set as in `tests/component/order-projection.component.spec.ts`, plus `GraphQLModule` (same factory), `OrdersResolver`, `ListOrdersService` and `configureApp`.
  - **Case**: place 2 orders via `POST /orders`, then poll `orders(limit: 10)` over GraphQL (≤ 30s) until both appear as `PENDING` with correct items, `totalAmount` and `placedAt`, the newest first. Then `POST /orders/:id/confirm` one of them and poll until the query shows `CONFIRMED` with `confirmedAt`.

### Implementation

- [X] T015 [US1] Add `list(filter: OrderViewFilter, page: PageRequest): Promise<OrderViewPage>` and the exported types `OrderViewFilter`/`PageRequest`/`OrderViewPage` to `src/read-model/order-view.repository.ts`:
  - `find(filter).sort({ placedAt: -1, _id: -1 }).skip(offset).limit(limit).lean()` and `countDocuments(filter)` in `Promise.all`, inside `guard`;
  - map documents with the existing `toView`;
  - build the filter only from defined keys.

  Extend `tests/integration/order-view.repository.integration.spec.ts` with sort, tie-break, nulls-last and paging cases.
- [X] T016 [US1] Create `ListOrdersQuery(filter: OrderViewFilter, page: PageRequest)` in `src/queries/list-orders.query.ts`, and `ListOrdersService` (`@QueryHandler(ListOrdersQuery)`, `ListOrdersResult { views, totalCount, hasNextPage }`) in `src/services/list-orders.service.ts`. JSDoc both. Makes T011 pass.
- [X] T017 [US1] Create `ListOrdersArgs` (`@ArgsType()`) in `src/dto/graphql/list-orders.args.ts` with `limit` (`@Field(() => Int, { defaultValue: 20, description })`, `@IsInt() @Min(1) @Max(100)`) and `offset` (`@Field(() => Int, { defaultValue: 0, description })`, `@IsInt() @Min(0)`). Filters are added in US2.
- [X] T018 [US1] Create `OrdersResolver` in `src/controllers/orders.resolver.ts`:
  - `@Resolver(() => OrderType)` with `@Query(() => OrdersPageType, { name: 'orders', description })`, `orders(@Args() args: ListOrdersArgs)`;
  - `queryBus.execute(new ListOrdersQuery(...))`, then map with `OrderType.fromView`.

  Makes T012 pass.
- [X] T019 [US1] Create the Apollo options factory `buildGraphqlOptions(config: ConfigService): ApolloDriverConfig` in `src/graphql/graphql.config.ts`: `autoSchemaFile: true`, `sortSchema: true`, `path: '/graphql'`, `playground: false`, `introspection: devTools`, `plugins: devTools ? [ApolloServerPluginLandingPageLocalDefault({ embed: true })] : []`. Register `GraphQLModule.forRootAsync<ApolloDriverConfig>({ driver: ApolloDriver, inject: [ConfigService], useFactory: buildGraphqlOptions })`, `OrdersResolver` and `ListOrdersService` in `src/app.module.ts`. Makes T013 (US1 cases) and T014 pass.

**Checkpoint**: MVP. Orders can be listed and paged over GraphQL from the read model.

---

## Phase 4: User Story 2 — Filter by status and customer (Priority: P1)

**Goal**: the optional `status` and `customerId` arguments filter the list (combined with AND). `totalCount` respects the filters, and each filter is served by its index.

**Independent Test**: seed orders for 2 customers in mixed statuses. Each filter and the combination returns exactly the matching orders with the correct `totalCount`. `explain()` shows an `IXSCAN` on the matching index.

### Tests (write first)

- [X] T020 [P] [US2] Extend `tests/unit/controllers/orders.resolver.spec.ts`: `status` and `customerId` args are passed into `ListOrdersQuery.filter`, and absent args are not set (no `undefined` keys).
- [X] T021 [US2] Extend `tests/integration/list-orders.graphql.integration.spec.ts`:
  - `orders(status: CANCELLED)` returns only cancelled orders, with `cancellationReason`;
  - `orders(customerId: A)` returns only A's;
  - both together;
  - a filter matching nothing gives `items: []`, `totalCount: 0`, `hasNextPage: false`;
  - paging inside a filter;
  - **index usage**: for the customer, status and unfiltered queries, run the same `find().sort()` with `.explain('queryPlanner')` directly on the model and assert the winning plan contains `IXSCAN` with `indexName` `customerId_placedAt`, `status_placedAt` or `placedAt` respectively (no `SORT` stage).
- [X] T022 [US2] Extend `tests/component/list-orders.component.spec.ts`: place an order for a second seeded customer, cancel one order via REST, then poll `orders(customerId: …)` and `orders(status: CANCELLED)` until the expected sets and `totalCount`s are returned.

### Implementation

- [X] T023 [US2] Add the optional `status` (`@Field(() => OrderViewStatus, { nullable: true, description })`, `@IsOptional() @IsEnum(OrderViewStatus)`) and `customerId` (`@Field(() => ID, { nullable: true, description })`, `@IsOptional() @IsUUID()`) args to `src/dto/graphql/list-orders.args.ts`. Pass them through in `src/controllers/orders.resolver.ts`, omitting undefined keys. Makes T020–T022 pass. (The repository filter from T015 already supports both.)

**Checkpoint**: filtering works and uses its indexes.

---

## Phase 5: User Story 3 — Clear errors for invalid requests (Priority: P2)

**Goal**: an invalid `limit`, `offset` or `customerId` gives `BAD_USER_INPUT` with a message naming the argument. An unknown `status` is rejected by enum validation. A read-model outage gives `SERVICE_UNAVAILABLE` without details. The service keeps serving.

**Independent Test**: send each invalid query, then a valid one. Each invalid query returns one error with the expected code and message and `data: null`, and the valid one succeeds.

### Tests (write first)

- [X] T024 [P] [US3] Unit tests in `tests/unit/graphql/graphql-user-input.filter.spec.ts`:
  - a `BadRequestException` carrying `message: ['limit must not be greater than 100']` becomes a `GraphQLError` with `extensions.code === 'BAD_USER_INPUT'`, that message, and `extensions.validationErrors` equal to the list;
  - a `BadRequestException` with a string message becomes `BAD_USER_INPUT` too;
  - `ReadModelUnavailableError(new Error('Authentication failed.'))` becomes `SERVICE_UNAVAILABLE` with the generic message, and the output contains no "Authentication" or cause;
  - any other error is rethrown unchanged.
- [X] T025 [P] [US3] Unit tests in `tests/unit/dto/list-orders.args.spec.ts` (`plainToInstance` + `validate`): `limit` 0, 101 and 1.5 are invalid; `limit` 1 and 100 are valid; `offset` -1 is invalid and 0 is valid; `customerId` `'abc'` is invalid and a UUID is valid; `status` `'SHIPPED'` is invalid.
- [X] T026 [US3] Extend `tests/integration/list-orders.graphql.integration.spec.ts`:
  - `limit: 0`, `limit: 101`, `offset: -1` and `customerId: "abc"` each give one error, `extensions.code === 'BAD_USER_INPUT'`, a message containing the argument name, and `data` null;
  - `status: SHIPPED` (literal) gives `GRAPHQL_VALIDATION_FAILED`, and the message lists the allowed values;
  - `status` via a variable `"SHIPPED"` gives `BAD_USER_INPUT`;
  - a valid query right after succeeds;
  - **outage**: stop the MongoDB container in a dedicated `describe` (its own container) and query → `SERVICE_UNAVAILABLE`, the generic message, no stack trace or cause in `extensions`.

### Implementation

- [X] T027 [US3] Create `GraphQLUserInputFilter` (`@Catch(BadRequestException, ReadModelUnavailableError)`, implementing `GqlExceptionFilter`) in `src/graphql/graphql-user-input.filter.ts`:
  - `BadRequestException`: build `UserInputError` (from `@nestjs/apollo`) with `message = messages.join('; ')` and `extensions.validationErrors = messages`;
  - `ReadModelUnavailableError`: throw `new GraphQLError('Order data is temporarily unavailable, please retry', { extensions: { code: 'SERVICE_UNAVAILABLE' } })`.

  Apply it with `@UseFilters(GraphQLUserInputFilter)` on `OrdersResolver` in `src/controllers/orders.resolver.ts`. Makes T024 and T026 pass. (T025 should already pass with the T017/T023 decorators; fix any rule that does not.)

**Checkpoint**: every invalid input gets a clear error, and outages don't leak internals.

---

## Phase 6: User Story 4 — Discover the API (Priority: P3)

**Goal**: outside production, the Apollo Sandbox at `GET /graphql` and introspection work, and every schema element has a description. In production both are off. The committed `docs/schema.gql` always matches the served schema.

**Independent Test**: dev app: an introspection query succeeds and `GET /graphql` (`Accept: text/html`) returns the sandbox HTML. A `NODE_ENV=production` app: introspection fails and there is no sandbox. `npm run schema:generate` leaves `git diff` clean.

### Tests (write first)

- [X] T028 [P] [US4] Unit test `tests/unit/graphql/schema.spec.ts`:
  - `printOrdersSchema()` equals the content of `docs/schema.gql`, after normalising line endings (drift check, FR-015);
  - build the `GraphQLSchema` with the same helper and walk every **non-introspection** named type (object fields with their args, enum values, input fields): every one has a non-empty `description` (FR-009, SC-006);
  - the schema contains `orders(status: OrderStatus, customerId: ID, limit: Int! = 20, offset: Int! = 0): OrdersPage!`.
- [X] T029 [US4] Extend `tests/integration/list-orders.graphql.integration.spec.ts`:
  - the dev app answers an introspection query (`__schema { queryType { name } }`), and `GET /graphql` with `Accept: text/html` returns 200 HTML mentioning the Apollo sandbox;
  - a second app built with `ConfigModule` loading `configuration` while `process.env.NODE_ENV = 'production'` (restored in `afterAll`) rejects the introspection query (error, no `__schema` data), and `GET /graphql` with `Accept: text/html` does not return the sandbox HTML.

### Implementation

- [X] T030 [US4] Create `printOrdersSchema(): Promise<string>` in `src/graphql/print-schema.ts`. Create a Nest application context from `GraphQLSchemaBuilderModule`, get `GraphQLSchemaFactory`, call `create([OrdersResolver])`, and return `printSchema(lexicographicSortSchema(schema))` with a trailing newline. Close the context.
- [X] T031 [US4] Create `scripts/generate-graphql-schema.ts`, which writes `printOrdersSchema()` to `docs/schema.gql`. Add the `"schema:generate": "ts-node scripts/generate-graphql-schema.ts"` script to `package.json`. Run it and commit `docs/schema.gql`. Makes T028 pass.
- [X] T032 [US4] Verify `src/graphql/graphql.config.ts` against T029 (introspection and landing page by `graphql.devTools`), and adjust if the production app still serves a landing page. Makes T029 pass.

**Checkpoint**: all four stories work.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T033 [P] Update `README.md`:
  - the read path becomes **built** (GraphQL `orders` query), with the endpoint `/graphql` and the sandbox note;
  - add an "Example GraphQL queries" section from `contracts/graphql-orders-query.md` (unfiltered, by status, by customer with paging, an error example);
  - the tests section mentions GraphQL integration tests;
  - link `docs/schema.gql`.
- [X] T034 [P] Update `CLAUDE.md`:
  - the read path becomes GraphQL → `QueryBus` → `@QueryHandler` → `OrderViewRepository` (built);
  - add the rule that resolvers live in `src/controllers/`, GraphQL types in `src/dto/graphql/` (built from `OrderView`), and queries in `src/queries/`;
  - every GraphQL type and field needs a description;
  - run `npm run schema:generate` after schema changes (the drift test enforces it).
- [X] T035 [P] Update `src/README.md`:
  - add rows for `queries/`, `dto/graphql/` and `graphql/`;
  - mention `OrdersResolver` in the controllers row;
  - add a "Where a GraphQL query goes" flow line.
- [X] T036 [P] Update `docs/read-model.md`: "Nothing reads it yet" becomes "Read by the GraphQL `orders` query (US-06)". Add the indexes table, and note that indexes are created on connect (`autoIndex` off).
- [X] T037 Run the full quality gate and `npm run test:cov`. Confirm all thresholds, including the new `src/controllers/**/*.resolver.ts` and `src/graphql/**` entries, and that `npm run schema:generate && git diff --exit-code docs/schema.gql` is clean.
- [ ] T038 Validate live with `specs/004-list-orders-graphql/quickstart.md` §2 against ecommerce-infra (and Payments, if running):
  - the sandbox loads;
  - existing orders are listed, and `totalCount` equals `db.order_views.countDocuments()`;
  - a new order appears within 5s and changes status after its payment;
  - the filters, paging and error examples behave as documented;
  - `getIndexes()` lists the three indexes.

  Record the results for the PR.

---

## Dependencies & Execution Order

- **Setup (T001–T003)**: no dependencies (T003 [P]).
- **Foundational (T004–T010)**: needs Setup. T006 → T007 → T008. T009 and T010 [P].
- **US1 (T011–T019)**: needs Foundational. **MVP.** T015 → T016 → T017 → T018 → T019.
- **US2 (T020–T023)**: needs US1 (the args, resolver and integration harness exist).
- **US3 (T024–T027)**: needs US1. T024 and T025 can start right after Foundational.
- **US4 (T028–T032)**: needs US1 (a resolver must exist to build a schema). Best after US2/US3, so the committed schema includes the final arguments.
- **Polish (T033–T038)**: after all stories. T033–T036 [P].

```text
Setup ──▶ Foundational ──▶ US1 (MVP) ──┬──▶ US2 ──┐
                                       ├──▶ US3 ──┼──▶ US4 ──▶ Polish
                                       └──────────┘
```

## Parallel Examples

- **Foundational**: T004 + T005 (tests) and T009 + T010 (types and their test) together, with T006 → T007 → T008 sequential.
- **US1**: T011 + T012 together (unit tests), then T015 → T019; T013 and T014 go green at T019.
- **US3**: T024 + T025 in parallel with US2's T020.
- **Polish**: T033–T036 together.

## Implementation Strategy

1. **MVP = Setup + Foundational + US1**: a paged, sorted order list over GraphQL from the read model.
2. **US2**: the two filters, index-backed (the everyday "my orders" and "orders by status" questions).
3. **US3**: consumer-friendly errors and outage handling.
4. **US4**: the sandbox, introspection rules, and the committed schema with its drift and description check.
5. **Polish**: docs, coverage, and live validation.
