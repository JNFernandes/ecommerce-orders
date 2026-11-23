import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { buildSwaggerDocument } from '../../src/app.swagger';
import { OrdersController } from '../../src/controllers/orders.controller';

type Operation = NonNullable<OpenAPIObject['paths'][string]['post']>;

describe('Swagger document (US-11: bearer auth, roles, 401/403/503)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [{ provide: CommandBus, useValue: {} }],
    }).compile();
    app = moduleRef.createNestApplication();
    document = buildSwaggerDocument(app);
  });

  afterAll(async () => {
    await app.close();
  });

  function operation(path: string): Operation {
    const found = document.paths[path]?.post;
    if (found === undefined) {
      throw new Error(`no POST ${path} in the document`);
    }
    return found;
  }

  it('declares a bearer JWT security scheme', () => {
    expect(document.components?.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it.each([
    ['/orders', 'Roles: `CUSTOMER`'],
    ['/orders/{orderId}/cancel', 'Roles: `CUSTOMER` (own orders) or `ADMIN` (any order)'],
    ['/orders/{orderId}/confirm', 'Roles: `ADMIN`'],
  ])('documents bearer auth, roles and 401/403/503 for POST %s', (path, roles) => {
    const op = operation(path);

    expect(op.security).toEqual([{ bearer: [] }]);
    expect(op.description).toContain(roles);
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['401', '403', '503']));
  });

  it('documents the exact 401, 403 and 503 bodies', () => {
    const responses = JSON.stringify(operation('/orders').responses);

    expect(responses).toContain(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }));
    expect(responses).toContain(
      JSON.stringify({ statusCode: 403, message: 'Forbidden', error: 'Forbidden' }),
    );
    expect(responses).toContain(
      JSON.stringify({ statusCode: 503, message: 'Service Unavailable' }),
    );
  });

  it('has no customerId in the place-order request body', () => {
    const schema = document.components?.schemas?.PlaceOrderDto;

    expect(schema).toBeDefined();
    expect(JSON.stringify(schema)).not.toContain('customerId');
  });

  it('contains no token-like string', () => {
    // A JWT is three base64url segments, the first starting with `eyJ` (`{"`).
    expect(JSON.stringify(document)).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]*/);
  });
});
