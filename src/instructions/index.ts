import { MAIL_INSTRUCTIONS } from './mail.js';
import { WORKSPACE_INSTRUCTIONS } from './workspace.js';

export const INSTRUCTIONS_BY_ENDPOINT: Record<string, string> = {
  mail: MAIL_INSTRUCTIONS,
  workspace: WORKSPACE_INSTRUCTIONS,
};
