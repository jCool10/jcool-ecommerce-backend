import { ApiProperty } from '@nestjs/swagger';
import type { User } from '../../domain/entities/user.entity';
import { ROLES } from '../../../../shared/rbac/role.enum';

/** Public view of a user — the safe subset only, always built via `fromEntity` so `passwordHash` (and any future internal field) can never leak. */
export class UserResponseDto {
  @ApiProperty({ example: '0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f', description: 'User id (UUID v7).' })
  id!: string;

  @ApiProperty({ example: 'user@example.com', format: 'email' })
  email!: string;

  @ApiProperty({ enum: ROLES, example: 'CUSTOMER' })
  role!: string;

  @ApiProperty({ example: false, description: 'Whether the email address has been verified.' })
  emailVerified!: boolean;

  static fromEntity(user: User): UserResponseDto {
    const dto = new UserResponseDto();
    dto.id = user.id;
    dto.email = user.email;
    dto.role = user.role;
    dto.emailVerified = user.isEmailVerified;
    return dto;
  }
}
