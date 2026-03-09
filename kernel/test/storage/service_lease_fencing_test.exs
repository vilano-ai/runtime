defmodule VilanoKernel.Storage.ServiceLeaseFencingTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage

  test "expired leases cannot ensure service instances" do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    expired_at = DateTime.utc_now() |> DateTime.add(-5, :second) |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    run_id = "run_" <> Ecto.UUID.generate()
    lease_id = "lease_" <> Ecto.UUID.generate()

    SQL.query!(
      Repo,
      """
      insert into runs (
        id,
        project_name,
        definition_kind,
        definition_name,
        project_snapshot_path,
        project_definitions_json,
        definition_file,
        definition_export_name,
        definition_runtime_kind,
        definition_source_language,
        status,
        lease_id,
        lease_auth_token,
        lease_worker_id,
        lease_expires_at,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      ) values (?, 'demo', 'workflow', 'caller', '/tmp/project', '{}', 'src/definitions.ts', 'caller', 'javascript', 'typescript', 'active', ?, 'lease-auth', 'managed-local-1', ?, '{}', null, null, ?, ?)
      """,
      [run_id, lease_id, expired_at, now, now]
    )

    project = %{
      "name" => "demo",
      "path" => "/tmp/project",
      "snapshotPath" => "/tmp/project",
      "definitions" => %{"workflows" => [], "services" => []}
    }

    definition = %{
      "name" => "reviewer",
      "file" => "src/definitions.ts",
      "exportName" => "reviewer",
      "runtimeKind" => "javascript",
      "sourceLanguage" => "typescript"
    }

    assert Storage.ensure_service_run!(project, definition, "repo-123", %{"repoId" => "repo-123"}, lease_id, false) ==
             nil

    service_runs =
      SQL.query!(Repo, "select count(*) from service_runs where service_key = 'repo-123'", [])
      |> first_integer()

    assert service_runs == 0
  end

  defp first_integer(%{rows: [[value]], columns: [_column]}), do: value
end
