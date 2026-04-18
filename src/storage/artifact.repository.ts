import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Artifact } from '../contracts/control-plane';
import { DatabaseService } from '../db/database.service';
import { runArtifacts } from '../db/schema';

@Injectable()
export class ArtifactRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: Omit<Artifact, 'id' | 'createdAt'>) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.database.db.insert(runArtifacts).values({
      id,
      runId: input.runId,
      kind: input.kind,
      label: input.label,
      uri: input.uri,
      inline: input.inline,
      createdAt
    });
    return { ...input, id, createdAt } satisfies Artifact;
  }

  async findById(id: string) {
    const rows = await this.database.db.select().from(runArtifacts).where(eq(runArtifacts.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listByRunId(runId: string) {
    return this.database.db
      .select()
      .from(runArtifacts)
      .where(eq(runArtifacts.runId, runId))
      .orderBy(asc(runArtifacts.createdAt));
  }
}
