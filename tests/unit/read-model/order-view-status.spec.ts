import { OrderViewStatus } from '../../../src/read-model/order-view-status.enum';
import { OrderStatus } from '../../../src/domain/order-status.enum';

// The only place the read and write status enums meet: they are declared separately on purpose
// (Constitution Principle II), but must keep the same values.
describe('OrderViewStatus', () => {
  it('should have exactly the same values as the write-side OrderStatus', () => {
    expect(Object.values(OrderViewStatus).sort()).toEqual(Object.values(OrderStatus).sort());
  });
});
