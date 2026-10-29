import type { TutorCitation, TutorErrorCode } from "./tutor-types";

export type PracticeMode = "quiz" | "exam" | "interview";

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
}

export interface GeneratedQuiz {
  status: "ready";
  attemptId: string;
  title: string;
  mode: PracticeMode;
  questions: QuizQuestion[];
}

export interface QuizFailure {
  status: "error";
  code: TutorErrorCode | "storage_unavailable" | "invalid_quiz";
  message: string;
}

export type QuizResponse = GeneratedQuiz | QuizFailure;

export interface QuizQuestionResult {
  id: string;
  prompt: string;
  options: string[];
  selectedIndex: number | null;
  correctIndex: number;
  correct: boolean;
  explanation: string;
  citations: TutorCitation[];
}

export interface QuizResult {
  status: "graded";
  attemptId: string;
  score: number;
  results: QuizQuestionResult[];
}

export type QuizGradeResponse = QuizResult | QuizFailure;
