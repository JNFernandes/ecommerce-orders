import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomerEntity } from '../infra/database/entities/customer.entity';

/** Port used by the write path to verify a customerId corresponds to an existing customer. */
@Injectable()
export class CustomerRepository {
  constructor(
    @InjectRepository(CustomerEntity)
    private readonly repository: Repository<CustomerEntity>,
  ) {}

  async existsById(customerId: string): Promise<boolean> {
    const count = await this.repository.countBy({ id: customerId });
    return count > 0;
  }
}
