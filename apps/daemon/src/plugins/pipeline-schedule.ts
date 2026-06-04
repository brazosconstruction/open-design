import type { PipelineStage, PluginPipeline } from '@open-design/contracts';

const POST_RUN_ATOMS = new Set([
  'visual-validation',
]);

export interface PipelineScheduleSplit {
  preRun: PluginPipeline | null;
  postRun: PluginPipeline | null;
}

export function splitPipelineByExecutionBoundary(
  pipeline: PluginPipeline | null | undefined,
): PipelineScheduleSplit {
  if (!pipeline?.stages?.length) {
    return { preRun: null, postRun: null };
  }

  const preRunStages: PipelineStage[] = [];
  const postRunStages: PipelineStage[] = [];
  for (const stage of pipeline.stages) {
    if (stage.atoms.some((atomId) => POST_RUN_ATOMS.has(atomId))) {
      postRunStages.push(stage);
    } else {
      preRunStages.push(stage);
    }
  }

  return {
    preRun: preRunStages.length > 0 ? { ...pipeline, stages: preRunStages } : null,
    postRun: postRunStages.length > 0 ? { ...pipeline, stages: postRunStages } : null,
  };
}
