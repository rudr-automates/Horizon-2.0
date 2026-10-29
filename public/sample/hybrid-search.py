"""Original demo: rank fusion, not an embedding service or AI model."""
def reciprocal_rank_fusion(keyword_ids, semantic_ids, k=60):
    scores = {}
    for ranking in (keyword_ids, semantic_ids):
        for rank, document_id in enumerate(dict.fromkeys(ranking), start=1):
            scores[document_id] = scores.get(document_id, 0) + 1 / (k + rank)
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)

if __name__ == "__main__":
    print(reciprocal_rank_fusion(["exact-term", "shared"], ["shared", "paraphrase"]))
