defmodule VilanoKernel.PruneManagerTest do
  use ExUnit.Case, async: false

  alias VilanoKernel.PruneManager

  @prune_env_keys [
    "VILANO_PRUNE_PROJECT_SNAPSHOT_GRACE_SECONDS",
    "VILANO_PRUNE_RUN_WORKSPACE_TTL_SECONDS",
    "VILANO_PRUNE_COMPLETED_RUN_TTL_SECONDS",
    "VILANO_PRUNE_SERVICE_ENVELOPE_TTL_SECONDS",
    "VILANO_PRUNE_ARTIFACT_GRACE_SECONDS",
    "VILANO_PRUNE_EVENT_PAYLOAD_GRACE_SECONDS",
    "VILANO_PRUNE_RUNTIME_CACHE_TTL_SECONDS",
    "VILANO_PRUNE_DAEMON_LOG_MAX_BYTES",
    "VILANO_PRUNE_INTERVAL_SECONDS",
    "VILANO_PRUNE_VACUUM_DATABASE"
  ]

  test "false vacuum env does not enable auto prune by itself" do
    previous = Map.new(@prune_env_keys, &{&1, System.get_env(&1)})

    try do
      Enum.each(@prune_env_keys, &System.delete_env/1)
      System.put_env("VILANO_PRUNE_VACUUM_DATABASE", "false")

      assert :ignore = PruneManager.start_link(nil)
    after
      Enum.each(previous, fn {key, value} -> restore_env(key, value) end)
    end
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
