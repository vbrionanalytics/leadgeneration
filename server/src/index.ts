import mongoose from 'mongoose';
import { env } from './config/env';
import { createApp } from './app';
import { logger } from './utils';
import { startWorker } from './jobs/worker';

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  logger.info('MongoDB connected');
  const app = createApp();
  const server = app.listen(env.PORT, () => logger.info(`API listening on :${env.PORT} (automation: ${env.AUTOMATION_MODE})`));

  // Run the background worker in-process unless a dedicated worker process is used (RUN_WORKER=false)
  const stopWorker = process.env.RUN_WORKER === 'false' ? null : startWorker();

  const shutdown = async (sig: string) => {
    logger.info(`${sig} received, shutting down`);
    stopWorker?.();
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.fatal(e, 'Failed to start');
  process.exit(1);
});
