import { buildApp } from './app.js';
import { startClaimTimeoutJob } from './jobs/claim-timeout.js';
import { startWinConditionJob } from './jobs/win-condition.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildApp();
startClaimTimeoutJob(app);
startWinConditionJob(app);

app
  .listen({ port, host })
  .then(() => {
    app.log.info(`server listening on http://${host}:${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
