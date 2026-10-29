/**
 * Narrow table contracts for the retrieval tables added by the Phase 2
 * migration. They live separately from the generated Supabase types so the app
 * can compile before `supabase gen types` is rerun after applying the migration.
 */
export interface AiDatabase {
  public: {
    Tables: {
      learning_resources: {
        Row: {
          id: string;
          owner_id: string | null;
          course_id: string | null;
          lesson_id: string | null;
          is_demo: boolean;
          kind: "video_transcript" | "pdf" | "slides" | "markdown" | "text" | "code";
          title: string;
          status: "pending" | "processing" | "ready" | "failed";
          source_url: string | null;
          content_hash: string | null;
          processing_error: string | null;
          metadata: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id?: string | null;
          course_id?: string | null;
          lesson_id?: string | null;
          is_demo?: boolean;
          kind: "video_transcript" | "pdf" | "slides" | "markdown" | "text" | "code";
          title: string;
          status?: "pending" | "processing" | "ready" | "failed";
          source_url?: string | null;
          content_hash?: string | null;
          processing_error?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<AiDatabase["public"]["Tables"]["learning_resources"]["Insert"]>;
        Relationships: [];
      };
      resource_chunks: {
        Row: {
          id: string;
          resource_id: string;
          chunk_index: number;
          heading: string | null;
          text: string;
          locator_kind: "video" | "page" | "slide" | "text";
          video_start_seconds: number | null;
          video_end_seconds: number | null;
          page_number: number | null;
          slide_number: number | null;
          section: string | null;
          embedding: string | null;
          embedding_space_key: string | null;
          embedding_provider: string | null;
          embedding_model: string | null;
          embedding_dimension: number | null;
          embedding_version: string | null;
          content_hash: string | null;
          metadata: Record<string, unknown>;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          resource_id: string;
          chunk_index: number;
          heading?: string | null;
          text: string;
          locator_kind: "video" | "page" | "slide" | "text";
          video_start_seconds?: number | null;
          video_end_seconds?: number | null;
          page_number?: number | null;
          slide_number?: number | null;
          section?: string | null;
          embedding?: string | null;
          embedding_space_key?: string | null;
          embedding_provider?: string | null;
          embedding_model?: string | null;
          embedding_dimension?: number | null;
          embedding_version?: string | null;
          content_hash?: string | null;
          metadata?: Record<string, unknown>;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<AiDatabase["public"]["Tables"]["resource_chunks"]["Insert"]>;
        Relationships: [];
      };
      tutor_exchanges: {
        Row: {
          id: string;
          user_id: string;
          lesson_id: string;
          position_seconds: number;
          mode: "question" | "explain" | "summary";
          question: string;
          answer: string;
          citations: unknown;
          provider_id: string | null;
          model_id: string | null;
          retrieval: string | null;
          helpful: boolean | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          lesson_id: string;
          position_seconds: number;
          mode?: "question" | "explain" | "summary";
          question: string;
          answer: string;
          citations?: unknown;
          provider_id?: string | null;
          model_id?: string | null;
          retrieval?: string | null;
          helpful?: boolean | null;
          created_at?: string;
        };
        Update: Partial<AiDatabase["public"]["Tables"]["tutor_exchanges"]["Insert"]>;
        Relationships: [];
      };
      quiz_attempts: {
        Row: {
          id: string;
          user_id: string;
          lesson_id: string;
          mode: "quiz" | "exam" | "interview";
          position_seconds: number;
          questions: unknown;
          answers: unknown;
          score: number | null;
          feedback: string | null;
          completed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          lesson_id: string;
          mode?: "quiz" | "exam" | "interview";
          position_seconds?: number;
          questions?: unknown;
          answers?: unknown;
          score?: number | null;
          feedback?: string | null;
          completed_at?: string | null;
          created_at?: string;
        };
        Update: Partial<AiDatabase["public"]["Tables"]["quiz_attempts"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
