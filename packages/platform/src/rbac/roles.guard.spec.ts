import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { describe, expect, it } from 'vitest';
import { Role } from './role.enum';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

@Roles(Role.Admin)
class AdminController {
  list(this: void): void {}

  @Roles(Role.Customer)
  mine(this: void): void {}

  @Roles(Role.Admin, Role.Customer)
  either(this: void): void {}
}

class OpenController {
  handle(this: void): void {}

  @Roles()
  emptyList(this: void): void {}
}

type User = { role: Role } | undefined;

function canActivate(controller: new () => object, handler: () => void, user: User): boolean {
  return new RolesGuard(new Reflector()).canActivate(new ExecutionContextHost([{ user }], controller, handler));
}

function refusal(controller: new () => object, handler: () => void, user: User): ForbiddenException {
  try {
    canActivate(controller, handler, user);
  } catch (error) {
    if (error instanceof ForbiddenException) return error;
    throw error;
  }
  throw new Error('expected the guard to refuse');
}

const admin = { role: Role.Admin };
const customer = { role: Role.Customer };

describe('RolesGuard', () => {
  it('allows a listed role, with a method list overriding the class list', () => {
    expect([
      canActivate(AdminController, AdminController.prototype.list, admin),
      canActivate(AdminController, AdminController.prototype.mine, customer),
      canActivate(AdminController, AdminController.prototype.either, customer),
      canActivate(OpenController, OpenController.prototype.handle, undefined),
      canActivate(OpenController, OpenController.prototype.emptyList, customer),
    ]).toEqual([true, true, true, true, true]);
    expect(() => canActivate(AdminController, AdminController.prototype.mine, admin)).toThrow(ForbiddenException);
  });

  it('refuses a request with no user when a role is required', () => {
    const error = refusal(AdminController, AdminController.prototype.list, undefined);

    expect((error.cause as Error).message).toBe('required role ADMIN, held none');
  });

  // The cause goes to the rejection log line; the client sees only the generic body.
  it('refuses a role that is not listed, naming both roles only in the cause', () => {
    const error = refusal(AdminController, AdminController.prototype.list, customer);

    expect((error.cause as Error).message).toBe('required role ADMIN, held CUSTOMER');
    expect(error.getResponse()).toEqual({ statusCode: 403, message: 'Insufficient permissions', error: 'Forbidden' });
  });
});
