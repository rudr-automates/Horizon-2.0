# Foundations of grounded AI

Original Horizon demonstration content. Narration uses synthetic speech.

## What is an embedding?

An embedding is a list of numbers that represents a piece of content. A trained model maps related meanings to nearby positions in a vector space. The numbers are not hand-written labels, and their meaning depends on the model.

`Content → model → vector`

## Similarity, not certainty

Imagine the phrases car repair and fixing an automobile. Their words differ, but their meanings are related. Embeddings can place them near each other. Cosine similarity measures how closely two vectors point in the same direction. It is a similarity score, not a probability of correctness.

`car repair ≈ fixing an automobile`

## A consistent vector space

Encode the query and the documents with the same compatible embedding model. Compare their vectors and rank candidate passages. An embedding does not verify a fact. It helps find material that might be useful, and the retrieved text still needs inspection.

`Query vector → compare → ranked passages`

## Two ways to search

Keyword search rewards exact terms. Semantic search uses embeddings to match related meanings. An error code such as E forty two benefits from exact matching, while a paraphrased question may benefit from semantic matching. Neither method is best for every query.

`Keyword precision + semantic meaning`

## Combine ranked results

Hybrid retrieval combines keyword and vector search. Reciprocal rank fusion is one way to merge results. For each result, add one divided by a constant plus its rank in each list. This uses rank rather than pretending that different search scores share the same scale.

`RRF score = Σ 1 / (k + rank)`

## Permissions come first

Search only sources the learner is allowed to read. For a video question at the current position, exclude future transcript segments before ranking evidence. Preserve the source title and timestamp with each passage. Good relevance never overrides ownership or scope.

`Allowed sources → eligible passages → ranking`

## Evidence before answers

Retrieval augmented generation supplies selected source passages to a language model. The model can then draft an answer with references to those passages. A knowledge graph can connect concepts and resources, but a graph edge is not automatically proof that a claim is true.

`Retrieve → inspect → answer → cite`

## Citations must support claims

A useful citation identifies a source and its location, such as a video timestamp or a PDF page. Check that the cited passage actually supports the claim. Adding a citation label does not make an answer grounded, and retrieval does not eliminate hallucinations.

`Claim + supporting passage + location`

## Know when to abstain

If the permitted evidence is missing or contradictory, say that there is not enough support. Distinguish source-supported facts from general explanation. Grounded systems reduce risk through permission checks, scoped retrieval, source inspection, and honest uncertainty, not through a promise of perfect accuracy.

`Insufficient evidence → explain the gap`
