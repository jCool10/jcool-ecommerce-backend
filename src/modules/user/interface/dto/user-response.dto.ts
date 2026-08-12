import { ApiProperty } from '@nestjs/swagger';
import type { User } from '../../domain/entities/user.entity';
import { ROLES } from '../../../../shared/rbac/role.enum';

/**
 * Public view of a user — the safe subset only. Always built via `fromEntity`
 * so `passwordHash` (and any future internal field) can never leak.
 */
export class UserResponseDto {
  @ApiProperty({ example: 'clx0abc123...', description: 'User id (cuid2).' })
  id!: string;

  @ApiProperty({ example: 'user@example.com', format: 'email' })
  email!: string;

  @ApiProperty({ enum: ROLES, example: 'CUSTOMER' })
  role!: string;

  static fromEntity(user: User): UserResponseDto {
    const dto = new UserResponseDto();
    dto.id = user.id;
    dto.email = user.email;
    dto.role = user.role;
    return dto;
  }
}
