import { DatabaseSync } from 'node:sqlite';
import { Auth } from './auth.js';
import { Config } from './config.js';
import { CallManager } from './llm/callManager.js';
import { ContentService } from './services/content.js';
import { ReviewService } from './services/review.js';

export interface Ctx {
  db: DatabaseSync;
  cfg: Config;
  auth: Auth;
  content: ContentService;
  review: ReviewService;
  callManager: CallManager | null;
}