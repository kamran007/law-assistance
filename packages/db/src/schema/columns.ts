import { sql } from 'drizzle-orm';
import { customType, datetime } from 'drizzle-orm/mysql-core';
import { v7 as uuidv7 } from 'uuid';

/**
 * UUID stored as BINARY(16) (TRD §4 conventions). UUID v7 is time-ordered, so inserts stay
 * append-friendly for InnoDB's clustered primary key. The API always sees canonical strings.
 */
export const uuidBin = customType<{ data: string; driverData: Buffer }>({
  dataType: () => 'binary(16)',
  toDriver: (value) => uuidToBuffer(value),
  fromDriver: (value) => bufferToUuid(value),
});

export function uuidToBuffer(value: string): Buffer {
  const hex = value.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new TypeError('Invalid UUID');
  return Buffer.from(hex, 'hex');
}

export function bufferToUuid(value: Buffer | Uint8Array): string {
  const h = Buffer.from(value).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const newId = (): string => uuidv7();

/** DATETIME(3) in UTC (not TIMESTAMP — avoids the 2038 limit). */
export const dt = (name: string) => datetime(name, { fsp: 3, mode: 'date' });

export const timestamps = {
  createdAt: dt('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: dt('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date()),
};
