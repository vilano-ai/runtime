defmodule VilanoKernel.Storage.Migrations.AddRunStepRetryColumns do
  @moduledoc false

  def version, do: 1
  def name, do: "add_run_step_retry_columns"

  def up do
    VilanoKernel.Storage.ensure_column!("run_steps", "attempt", "integer")
    VilanoKernel.Storage.ensure_column!("run_steps", "max_attempts", "integer")
    VilanoKernel.Storage.ensure_column!("run_steps", "backoff_kind", "text")
    VilanoKernel.Storage.ensure_column!("run_steps", "backoff_ms", "integer")
    VilanoKernel.Storage.ensure_column!("run_steps", "backoff_step_ms", "integer")
    VilanoKernel.Storage.ensure_column!("run_steps", "backoff_factor", "real")
    VilanoKernel.Storage.ensure_column!("run_steps", "max_backoff_ms", "integer")
    VilanoKernel.Storage.ensure_column!("run_steps", "backoff_jitter_kind", "text")
    VilanoKernel.Storage.ensure_column!("run_steps", "backoff_jitter_ratio", "real")
    VilanoKernel.Storage.ensure_column!("run_steps", "retry_on_json", "text")
    VilanoKernel.Storage.ensure_column!("run_steps", "timeout_ms", "integer")
    VilanoKernel.Storage.ensure_column!("run_steps", "error_json", "text")
  end
end
