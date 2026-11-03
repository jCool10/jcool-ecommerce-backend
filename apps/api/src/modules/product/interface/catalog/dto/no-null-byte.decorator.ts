import { Matches } from 'class-validator';

/** Postgres text columns reject a NUL byte (SQLSTATE 22021), which would otherwise surface as a 500. */
export const NoNullByte = (): PropertyDecorator =>
  Matches(/^[^\0]*$/, { message: '$property must not contain a null byte' });
