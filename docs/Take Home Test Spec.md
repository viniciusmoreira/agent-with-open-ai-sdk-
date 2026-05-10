# 

# Take-Home Test — Senior Engineer

2026-04-12

# Take-Home Test — Senior Engineer

## The Task

Build an agent for a construction estimating team. The agent ingests project data, understands it, and answers questions about it.

You will work with:

1. **A CSV file** — bid tabulation data from a state DOT project (provided)

2. **A PDF plan set** — a few pages from a real construction project (provided)

Build a system that:

* Accepts file uploads (CSV and PDF)

* Parses and stores the content

* Generates embeddings for semantic search

* Answers natural language questions about the uploaded data

## Data

### CSV — Bid Tabulation Data (Provided)

A CSV file with bid tabulation data from state DOT projects. Column names may be abbreviated, inconsistent, or domain-specific. Some fields may be empty or contain unexpected formats.

We do not document the columns. Part of the test is figuring out the data.

### PDF — Plan Set Pages (Provided)

A few pages from a construction plan set. These are scanned images with text, tables, and drawings. The text is not selectable — extraction requires OCR or document understanding.

We do not tell you what to extract. Part of the test is deciding what matters.

## Requirements

* Use the OpenAI SDK for embeddings (text-embedding-3-small or text-embedding-3-large)

* You may use any LLM provider for the agent’s reasoning (OpenAI, Anthropic, Google, local models)

* You may use Claude Code or any AI tooling during development

* Store embeddings in any vector store (in-memory, SQLite, pgvector, Pinecone — your choice)

* The system must be runnable locally with a README that gets us from clone to working in under 5 minutes

## What the Agent Should Handle

The agent should be able to answer questions like:

* “What are the top 5 most expensive bid items?”

* “Are there any items with unit prices that deviate significantly from the average?”

* “What does the plan set say about drainage requirements?”

* “Summarize the key quantities from the bid data”

These are examples, not an exhaustive list. The agent should handle reasonable follow-up questions about the data it ingested.

## What We’re Evaluating

**Architecture decisions.** How you structure the system — file parsing, chunking strategy, embedding storage, retrieval, and response generation. We care about why you made your choices.

**Data handling.** How you deal with messy inputs — CSV columns you’ve never seen, PDF pages that don’t OCR cleanly, missing data, inconsistent formats.

**Query quality.** Whether the agent returns accurate, grounded answers — and whether it knows when it doesn’t have enough information.

**Deviation detection.** Can the agent identify outliers in the bid data? If a unit price is 10x the average for similar items, does the system surface that?

**Code quality.** Readable, well-structured code. Tests where they matter. No over-engineering.

## What Separates Good from Great

A good submission parses the files, generates embeddings, and answers questions.

A great submission builds an interface that an LLM can operate — where the agent’s capabilities are exposed as structured tools that another system could call programmatically. Think: tool-use patterns, structured inputs/outputs, composable operations.

## What We’re Not Evaluating

* UI polish — a CLI or simple web form is fine

* Deployment — local only

* Perfect OCR — we know plan sets are messy. How you handle the mess matters more than perfect extraction.

## Time

Expect \~3-4 hours of focused work. We’re not looking for a production system — we’re looking at how you think, what you prioritize, and what you leave out deliberately.

## Submission

Push to a GitHub repo (public or private — invite us if private) with a README that includes:

1. How to run it

2. Key decisions you made and why

3. What you’d change with more time