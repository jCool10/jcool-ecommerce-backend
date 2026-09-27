import { ApiProperty } from '@nestjs/swagger';
import type { ActiveSession } from '../../application/ports';

export class SessionResponseDto {
  @ApiProperty({ example: '137465797020397179', description: 'Session id (token family), a decimal string.' })
  id!: string;

  @ApiProperty({ description: 'When the session token was last issued (advances on refresh).', format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ description: 'When the session expires if unused.', format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ example: false, description: 'True for the session making this request.' })
  current!: boolean;

  static fromActive(session: ActiveSession): SessionResponseDto {
    const dto = new SessionResponseDto();
    dto.id = session.id;
    dto.createdAt = session.createdAt.toISOString();
    dto.expiresAt = session.expiresAt.toISOString();
    dto.current = session.current;
    return dto;
  }
}
