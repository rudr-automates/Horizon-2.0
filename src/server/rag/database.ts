/**
 * Narrow contracts for the additive pgvector tables. Kept separate from the
 * generated Supabase types so the application compiles before the migration is
 * reflected by `supabase gen types`.
 */
export interface RagChunkRow {
  id: string;
  lesson_id: string;
  chunk_index: number;
  text: string;
  start_seconds: number;
  end_seconds: number;
  similarity: number | null;
}

export interface RagDatabase {
  public: {
    Tables: {
      video_indexes: {
        Row: {
          lesson_id: string;
          status: "pending" | "processing" | "ready" | "failed";
          error: string | null;
          chunk_count: number;
          source_hash: string | null;
          embedding_provider: string | null;
          embedding_model: string | null;
          embedding_dimension: number | null;
          embedding_space_key: string | null;
          indexed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          lesson_id: string;
          status?: "pending" | "processing" | "ready" | "failed";
          error?: string | null;
          chunk_count?: number;
          source_hash?: string | null;
          embedding_provider?: string | null;
          embedding_model?: string | null;
          embedding_dimension?: number | null;
          embedding_space_key?: string | null;
          indexed_at?: string | null;
        };
        Update: {
          status?: "pending" | "processing" | "ready" | "failed";
          error?: string | null;
          chunk_count?: number;
          source_hash?: string | null;
          embedding_provider?: string | null;
          embedding_model?: string | null;
          embedding_dimension?: number | null;
          embedding_space_key?: string | null;
          indexed_at?: string | null;
        };
        Relationships: [];
      };
      video_chunks: {
        Row: {
          id: string;
          lesson_id: string;
          chunk_index: number;
          text: string;
          start_seconds: number;
          end_seconds: number;
          embedding: string;
          embedding_provider: string;
          embedding_model: string;
          embedding_dimension: number;
          embedding_space_key: string;
          content_hash: string;
          metadata: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          lesson_id: string;
          chunk_index: number;
          text: string;
          start_seconds: number;
          end_seconds: number;
          embedding: string;
          embedding_provider: string;
          embedding_model: string;
          embedding_dimension: number;
          embedding_space_key: string;
          content_hash: string;
          metadata?: Record<string, unknown>;
        };
        Update: Partial<{
          text: string;
          start_seconds: number;
          end_seconds: number;
          embedding: string;
          content_hash: string;
          metadata: Record<string, unknown>;
        }>;
        Relationships: [];
      };
      lessons: {
        Row: {
          id: string;
          title: string;
          user_id: string | null;
          course_id: string | null;
          is_demo: boolean;
          duration_seconds: number;
          transcript: unknown;
        };
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      match_video_chunks: {
        Args: {
          query_embedding: string;
          target_lesson_id: string;
          max_position_seconds: number;
          match_count?: number;
        };
        Returns: RagChunkRow[];
      };
      list_covered_video_chunks: {
        Args: {
          target_lesson_id: string;
          max_position_seconds: number;
          match_count?: number;
        };
        Returns: RagChunkRow[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
