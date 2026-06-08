// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuestionFormView } from '../../src/components/QuestionForm';
import type { QuestionForm } from '../../src/artifacts/question-form';

const form: QuestionForm = {
  id: 'discovery',
  title: 'Quick brief',
  questions: [
    {
      id: 'platform',
      label: 'Where is this post going?',
      type: 'radio',
      required: true,
      options: [
        { label: 'Facebook', value: 'facebook' },
        { label: 'Instagram feed', value: 'instagram-feed' },
      ],
    },
    {
      id: 'tone',
      label: 'Tone',
      type: 'checkbox',
      maxSelections: 2,
      options: [
        { label: 'Trustworthy', value: 'trustworthy' },
        { label: 'Warm', value: 'warm' },
      ],
    },
  ],
};

afterEach(() => cleanup());

describe('QuestionFormView interactions', () => {
  it('updates chip selections when the visible pill text is clicked', () => {
    render(<QuestionFormView form={form} interactive onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByText('Facebook'));
    fireEvent.click(screen.getByText('Warm'));

    expect((screen.getByLabelText('Facebook') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Warm') as HTMLInputElement).checked).toBe(true);
  });

  it('does not update chips while locked', () => {
    render(<QuestionFormView form={form} interactive={false} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByText('Facebook'));

    expect((screen.getByLabelText('Facebook') as HTMLInputElement).checked).toBe(false);
  });
});
