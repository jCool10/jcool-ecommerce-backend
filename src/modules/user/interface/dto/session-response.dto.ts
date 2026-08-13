import { ApiProperty } from '@nestjs/swagger';
import type { ActiveSession } from '../../application/ports';

/** Public view of one active session for GET /auth/sessions; `id` is passed to DELETE /auth/sessions/:id. */
export class SessionResponseDto {
  @ApiProperty({ example: '0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f', description: 'Session id (token family, UUID).' })
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
