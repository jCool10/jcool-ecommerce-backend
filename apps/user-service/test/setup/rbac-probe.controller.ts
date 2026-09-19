import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Roles } from '@jcool/platform/rbac';

/** This service ships no admin route; the probe gives RolesGuard one to guard. */
@Controller('admin-probe')
export class RbacProbeController {
  @Post()
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  probe(): void {}
}
