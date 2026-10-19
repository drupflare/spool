import { handle } from 'hono/aws-lambda';
import app from './hono';

export const handler = handle(app);
