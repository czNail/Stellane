import { z } from 'zod';
import { connectionInput } from './models.ts';
import { neonInput } from './neon-models.ts';

export const connectionUrlInput = z.strictObject({
  name: connectionInput.shape.name,
  projectPath: connectionInput.shape.projectPath,
  connectionString: z.string().trim().min(1).max(8192),
});
export const connectPostgresInput = z.union([connectionUrlInput, connectionInput]);
export const connectNeonInput = connectionUrlInput.extend({
  projectId: neonInput.shape.projectId,
  branchId: neonInput.shape.branchId,
  apiKey: z.string().trim().min(1).max(8192).regex(/^[^\r\n]+$/),
});
