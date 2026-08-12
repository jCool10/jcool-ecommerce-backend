import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { Role } from './role.enum';
import { ROLES_KEY, Roles } from './roles.decorator';

/**
 * `@Roles` just writes the allowed roles onto ROLES_KEY metadata; RolesGuard
 * reads them (covered in roles.guard.spec). Here we prove the write: the exact
 * roles land under the exact key the guard looks up. Applied at class level so
 * the metadata target is the constructor (no unbound method reference).
 */
describe('@Roles', () => {
  const reflector = new Reflector();

  it('stores a single required role under ROLES_KEY', () => {
    @Roles(Role.Admin)
    class AdminCtrl {}
    expect(reflector.get(ROLES_KEY, AdminCtrl)).toEqual([Role.Admin]);
  });

  it('preserves every role when several are allowed', () => {
    @Roles(Role.Admin, Role.Customer)
    class MixedCtrl {}
    expect(reflector.get(ROLES_KEY, MixedCtrl)).toEqual(['ADMIN', 'CUSTOMER']);
  });

  it('leaves no ROLES_KEY metadata on an undecorated target', () => {
    class PlainCtrl {}
    expect(reflector.get(ROLES_KEY, PlainCtrl)).toBeUndefined();
  });
});
