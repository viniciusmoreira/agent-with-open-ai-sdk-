export const SUGGESTED_QUESTIONS = [
  "What are the top 5 most expensive bid items?",
  "Are there any items with unit prices that deviate significantly from the average?",
  "What does the plan set say about drainage requirements?",
  "Summarize the key quantities from the bid data",
] as const;

export type SuggestedQuestion = (typeof SUGGESTED_QUESTIONS)[number];
