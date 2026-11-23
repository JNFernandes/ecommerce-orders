import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { PlaceOrderDto } from '../../../src/dto/place-order.dto';

/** The same pipe options as `configureApp` (src/app.setup.ts). */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const metadata: ArgumentMetadata = { type: 'body', metatype: PlaceOrderDto };
const ITEMS = [{ productId: 'prod-001', quantity: 2, unitPrice: 29.99 }];

describe('PlaceOrderDto validation (US-11: the customer comes from the token)', () => {
  it('should accept a body holding only items', async () => {
    const dto = (await pipe.transform({ items: ITEMS }, metadata)) as PlaceOrderDto;

    expect(dto).toBeInstanceOf(PlaceOrderDto);
    expect(dto.items).toHaveLength(1);
    expect(dto).not.toHaveProperty('customerId');
  });

  it('should reject a body with a customerId', async () => {
    const body = { customerId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', items: ITEMS };

    await expect(pipe.transform(body, metadata)).rejects.toThrow(BadRequestException);
  });

  it('should still reject a body without items', async () => {
    await expect(pipe.transform({}, metadata)).rejects.toThrow(BadRequestException);
  });
});
