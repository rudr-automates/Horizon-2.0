export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18";
  };
  public: {
    Tables: {
      transcription_jobs: {
        Row: {
          id: string;
          user_id: string;
          lesson_id: string;
          media_path: string;
          status: string;
          attempt_count: number;
          max_attempts: number;
          next_attempt_at: string;
          worker_id: string | null;
          lease_token: string | null;
          lease_expires_at: string | null;
          heartbeat_at: string | null;
          progress: Json;
          error_code: string | null;
          error_message: string | null;
          resource_id: string | null;
          model_metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          lesson_id: string;
          media_path: string;
          status?: string;
          attempt_count?: number;
          max_attempts?: number;
          next_attempt_at?: string;
          worker_id?: string | null;
          lease_token?: string | null;
          lease_expires_at?: string | null;
          heartbeat_at?: string | null;
          progress?: Json;
          error_code?: string | null;
          error_message?: string | null;
          resource_id?: string | null;
          model_metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["transcription_jobs"]["Insert"]>;
        Relationships: [];
      };
      transcription_workers: {
        Row: { worker_id: string; state: string; last_seen_at: string; metadata: Json };
        Insert: { worker_id: string; state?: string; last_seen_at?: string; metadata?: Json };
        Update: Partial<Database["public"]["Tables"]["transcription_workers"]["Insert"]>;
        Relationships: [];
      };
      courses: {
        Row: {
          category: string;
          created_at: string;
          description: string;
          id: string;
          is_demo: boolean;
          objectives: string[];
          title: string;
          updated_at: string;
        };
        Insert: {
          category?: string;
          created_at?: string;
          description: string;
          id: string;
          is_demo?: boolean;
          objectives?: string[];
          title: string;
          updated_at?: string;
        };
        Update: {
          category?: string;
          created_at?: string;
          description?: string;
          id?: string;
          is_demo?: boolean;
          objectives?: string[];
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      events: {
        Row: {
          completed: boolean;
          created_at: string;
          description: string | null;
          ends_at: string;
          id: string;
          kind: string;
          starts_at: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          completed?: boolean;
          created_at?: string;
          description?: string | null;
          ends_at: string;
          id?: string;
          kind?: string;
          starts_at: string;
          title: string;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          completed?: boolean;
          created_at?: string;
          description?: string | null;
          ends_at?: string;
          id?: string;
          kind?: string;
          starts_at?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      focus_sessions: {
        Row: {
          actual_seconds: number;
          created_at: string;
          ended_at: string;
          id: string;
          label: string | null;
          planned_minutes: number;
          started_at: string;
          status: string;
          task_id: string | null;
          user_id: string;
        };
        Insert: {
          actual_seconds: number;
          created_at?: string;
          ended_at: string;
          id?: string;
          label?: string | null;
          planned_minutes: number;
          started_at: string;
          status?: string;
          task_id?: string | null;
          user_id?: string;
        };
        Update: {
          actual_seconds?: number;
          created_at?: string;
          ended_at?: string;
          id?: string;
          label?: string | null;
          planned_minutes?: number;
          started_at?: string;
          status?: string;
          task_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "focus_sessions_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      learning_resources: {
        Row: {
          content_hash: string | null;
          course_id: string | null;
          created_at: string;
          id: string;
          is_demo: boolean;
          kind: string;
          lesson_id: string | null;
          metadata: Json;
          owner_id: string | null;
          processing_error: string | null;
          source_url: string | null;
          status: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          content_hash?: string | null;
          course_id?: string | null;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          kind: string;
          lesson_id?: string | null;
          metadata?: Json;
          owner_id?: string | null;
          processing_error?: string | null;
          source_url?: string | null;
          status?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          content_hash?: string | null;
          course_id?: string | null;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          kind?: string;
          lesson_id?: string | null;
          metadata?: Json;
          owner_id?: string | null;
          processing_error?: string | null;
          source_url?: string | null;
          status?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "learning_resources_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "learning_resources_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
      lesson_bookmarks: {
        Row: {
          created_at: string;
          id: string;
          label: string;
          lesson_id: string;
          timestamp_seconds: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          label?: string;
          lesson_id: string;
          timestamp_seconds: number;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          label?: string;
          lesson_id?: string;
          timestamp_seconds?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lesson_bookmarks_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
      lesson_notes: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          lesson_id: string;
          timestamp_seconds: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          lesson_id: string;
          timestamp_seconds?: number;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          lesson_id?: string;
          timestamp_seconds?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lesson_notes_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
      lesson_progress: {
        Row: {
          completed: boolean;
          created_at: string;
          id: string;
          lesson_id: string;
          position_seconds: number;
          updated_at: string;
          user_id: string;
          watched_seconds: number;
        };
        Insert: {
          completed?: boolean;
          created_at?: string;
          id?: string;
          lesson_id: string;
          position_seconds?: number;
          updated_at?: string;
          user_id?: string;
          watched_seconds?: number;
        };
        Update: {
          completed?: boolean;
          created_at?: string;
          id?: string;
          lesson_id?: string;
          position_seconds?: number;
          updated_at?: string;
          user_id?: string;
          watched_seconds?: number;
        };
        Relationships: [
          {
            foreignKeyName: "lesson_progress_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
      lessons: {
        Row: {
          course_id: string | null;
          created_at: string;
          description: string;
          duration_seconds: number;
          id: string;
          is_demo: boolean;
          position: number;
          provider: string;
          title: string;
          transcript: Json;
          transcript_status: string;
          updated_at: string;
          user_id: string | null;
          video_url: string;
        };
        Insert: {
          course_id?: string | null;
          created_at?: string;
          description?: string;
          duration_seconds?: number;
          id?: string;
          is_demo?: boolean;
          position?: number;
          provider?: string;
          title: string;
          transcript?: Json;
          transcript_status?: string;
          updated_at?: string;
          user_id?: string | null;
          video_url: string;
        };
        Update: {
          course_id?: string | null;
          created_at?: string;
          description?: string;
          duration_seconds?: number;
          id?: string;
          is_demo?: boolean;
          position?: number;
          provider?: string;
          title?: string;
          transcript?: Json;
          transcript_status?: string;
          updated_at?: string;
          user_id?: string | null;
          video_url?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lessons_course_id_fkey";
            columns: ["course_id"];
            isOneToOne: false;
            referencedRelation: "courses";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string | null;
          experience_level: string | null;
          explanation_style: string | null;
          goals: string | null;
          id: string;
          main_objective: string | null;
          onboarding_completed: boolean;
          onboarding_step: number;
          study_days: string[];
          study_hours: string | null;
          target_date: string | null;
          timezone: string;
          updated_at: string;
          weekly_target_minutes: number;
        };
        Insert: {
          created_at?: string;
          display_name?: string | null;
          experience_level?: string | null;
          explanation_style?: string | null;
          goals?: string | null;
          id: string;
          main_objective?: string | null;
          onboarding_completed?: boolean;
          onboarding_step?: number;
          study_days?: string[];
          study_hours?: string | null;
          target_date?: string | null;
          timezone?: string;
          updated_at?: string;
          weekly_target_minutes?: number;
        };
        Update: {
          created_at?: string;
          display_name?: string | null;
          experience_level?: string | null;
          explanation_style?: string | null;
          goals?: string | null;
          id?: string;
          main_objective?: string | null;
          onboarding_completed?: boolean;
          onboarding_step?: number;
          study_days?: string[];
          study_hours?: string | null;
          target_date?: string | null;
          timezone?: string;
          updated_at?: string;
          weekly_target_minutes?: number;
        };
        Relationships: [];
      };
      quiz_attempts: {
        Row: {
          answers: Json;
          completed_at: string | null;
          created_at: string;
          feedback: string | null;
          id: string;
          lesson_id: string;
          mode: string;
          position_seconds: number;
          questions: Json;
          score: number | null;
          user_id: string;
        };
        Insert: {
          answers?: Json;
          completed_at?: string | null;
          created_at?: string;
          feedback?: string | null;
          id?: string;
          lesson_id: string;
          mode?: string;
          position_seconds?: number;
          questions?: Json;
          score?: number | null;
          user_id?: string;
        };
        Update: {
          answers?: Json;
          completed_at?: string | null;
          created_at?: string;
          feedback?: string | null;
          id?: string;
          lesson_id?: string;
          mode?: string;
          position_seconds?: number;
          questions?: Json;
          score?: number | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "quiz_attempts_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_chunks: {
        Row: {
          chunk_index: number;
          content_hash: string | null;
          created_at: string;
          embedding: string | null;
          embedding_dimension: number | null;
          embedding_model: string | null;
          embedding_provider: string | null;
          embedding_space_key: string | null;
          embedding_version: string | null;
          heading: string | null;
          id: string;
          locator_kind: string;
          metadata: Json;
          page_number: number | null;
          resource_id: string;
          section: string | null;
          slide_number: number | null;
          text: string;
          text_search: unknown;
          updated_at: string;
          video_end_seconds: number | null;
          video_start_seconds: number | null;
        };
        Insert: {
          chunk_index: number;
          content_hash?: string | null;
          created_at?: string;
          embedding?: string | null;
          embedding_dimension?: number | null;
          embedding_model?: string | null;
          embedding_provider?: string | null;
          embedding_space_key?: string | null;
          embedding_version?: string | null;
          heading?: string | null;
          id?: string;
          locator_kind: string;
          metadata?: Json;
          page_number?: number | null;
          resource_id: string;
          section?: string | null;
          slide_number?: number | null;
          text: string;
          text_search?: unknown;
          updated_at?: string;
          video_end_seconds?: number | null;
          video_start_seconds?: number | null;
        };
        Update: {
          chunk_index?: number;
          content_hash?: string | null;
          created_at?: string;
          embedding?: string | null;
          embedding_dimension?: number | null;
          embedding_model?: string | null;
          embedding_provider?: string | null;
          embedding_space_key?: string | null;
          embedding_version?: string | null;
          heading?: string | null;
          id?: string;
          locator_kind?: string;
          metadata?: Json;
          page_number?: number | null;
          resource_id?: string;
          section?: string | null;
          slide_number?: number | null;
          text?: string;
          text_search?: unknown;
          updated_at?: string;
          video_end_seconds?: number | null;
          video_start_seconds?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "resource_chunks_resource_id_fkey";
            columns: ["resource_id"];
            isOneToOne: false;
            referencedRelation: "learning_resources";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          completed: boolean;
          created_at: string;
          due_date: string | null;
          id: string;
          notes: string | null;
          priority: string;
          tag: string | null;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          completed?: boolean;
          created_at?: string;
          due_date?: string | null;
          id?: string;
          notes?: string | null;
          priority?: string;
          tag?: string | null;
          title: string;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          completed?: boolean;
          created_at?: string;
          due_date?: string | null;
          id?: string;
          notes?: string | null;
          priority?: string;
          tag?: string | null;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      tutor_exchanges: {
        Row: {
          answer: string;
          citations: Json;
          created_at: string;
          helpful: boolean | null;
          id: string;
          lesson_id: string;
          mode: string;
          model_id: string | null;
          position_seconds: number;
          provider_id: string | null;
          question: string;
          retrieval: string | null;
          user_id: string;
        };
        Insert: {
          answer: string;
          citations?: Json;
          created_at?: string;
          helpful?: boolean | null;
          id?: string;
          lesson_id: string;
          mode?: string;
          model_id?: string | null;
          position_seconds: number;
          provider_id?: string | null;
          question: string;
          retrieval?: string | null;
          user_id?: string;
        };
        Update: {
          answer?: string;
          citations?: Json;
          created_at?: string;
          helpful?: boolean | null;
          id?: string;
          lesson_id?: string;
          mode?: string;
          model_id?: string | null;
          position_seconds?: number;
          provider_id?: string | null;
          question?: string;
          retrieval?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tutor_exchanges_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      claim_transcription_job: {
        Args: { p_worker_id: string };
        Returns: Database["public"]["Tables"]["transcription_jobs"]["Row"][];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
