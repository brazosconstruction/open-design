import { describe, expect, it } from 'vitest';
import type { PluginPipeline } from '@open-design/contracts';
import { splitPipelineByExecutionBoundary } from '../src/plugins/pipeline-schedule.js';

describe('splitPipelineByExecutionBoundary', () => {
  it('keeps pre-run-only pipelines intact', () => {
    const pipeline: PluginPipeline = {
      stages: [
        { id: 'discovery', atoms: ['discovery-question-form'] },
        { id: 'plan', atoms: ['todo-write'] },
      ],
    };

    const schedule = splitPipelineByExecutionBoundary(pipeline);

    expect(schedule.preRun).toEqual(pipeline);
    expect(schedule.postRun).toBeNull();
  });

  it('defers visual-validation stages until after the run succeeds', () => {
    const pipeline: PluginPipeline = {
      stages: [
        { id: 'discovery', atoms: ['discovery-question-form'] },
        { id: 'generate', atoms: ['file-write', 'live-artifact'] },
        {
          id: 'critique',
          atoms: ['critique-theater', 'visual-validation'],
          repeat: true,
          until: 'critique.score>=4 || iterations>=3',
        },
      ],
    };

    const schedule = splitPipelineByExecutionBoundary(pipeline);

    expect(schedule.preRun?.stages.map((stage) => stage.id)).toEqual([
      'discovery',
      'generate',
    ]);
    expect(schedule.postRun?.stages.map((stage) => stage.id)).toEqual([
      'critique',
    ]);
  });
});
