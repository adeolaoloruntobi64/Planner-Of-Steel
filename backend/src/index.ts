import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import degreePlannerRouter from './routes';
import coursesRouter from './courses/routes';
import plannerRouter from './planner.routes';
import groupPlannerRouter from './groupPlanner.routes';
import programsRouter from './programs/routes';
import debugRouter from './debug/routes';
import { closeSteelPool } from './courses/steelPool';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/degree-planner', degreePlannerRouter);
app.use('/api/courses', coursesRouter);
app.use('/api/plan', plannerRouter);
app.use('/api/group-plan', groupPlannerRouter);
app.use('/api/programs', programsRouter);
app.use('/api/debug', debugRouter);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

async function shutdown() {
  console.log('Shutting down, releasing any pooled Steel sessions...');
  await closeSteelPool();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);