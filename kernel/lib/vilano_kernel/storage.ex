defmodule VilanoKernel.Storage do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def init! do
    SQL.query!(Repo, "pragma journal_mode = wal", [])
    SQL.query!(Repo, "pragma foreign_keys = on", [])
    SQL.query!(Repo, "pragma busy_timeout = 5000", [])

    SQL.query!(
      Repo,
      """
      create table if not exists projects (
        name text primary key,
        path text not null,
        last_synced_at text,
        definitions_manifest_hash text,
        workflows_json text not null,
        services_json text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists runs (
        id text primary key,
        project_name text not null,
        definition_kind text not null,
        definition_name text not null,
        status text not null,
        input_json text not null,
        output_json text,
        error_json text,
        created_at text not null,
        updated_at text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_events (
        id text primary key,
        run_id text not null,
        seq integer not null,
        event_type text not null,
        body_json text not null,
        created_at text not null,
        unique (run_id, seq)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists runs_project_created_at_idx
      on runs(project_name, created_at desc)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_events_run_seq_idx
      on run_events(run_id, seq)
      """,
      []
    )
  end

  def project_count do
    Repo
    |> SQL.query!("select count(*) from projects", [])
    |> first_integer()
  end

  def list_projects do
    Repo
    |> SQL.query!(
      """
      select
        name,
        path,
        last_synced_at,
        definitions_manifest_hash,
        workflows_json,
        services_json
      from projects
      order by name asc
      """,
      []
    )
    |> rows_to_maps()
    |> Enum.map(&project_from_row/1)
  end

  def get_project(name) do
    Repo
    |> SQL.query!(
      """
      select
        name,
        path,
        last_synced_at,
        definitions_manifest_hash,
        workflows_json,
        services_json
      from projects
      where name = ?
      """,
      [name]
    )
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> project_from_row(row)
    end
  end

  def upsert_project!(project) do
    workflows_json = Jason.encode!(get_in(project, ["definitions", "workflows"]) || [])
    services_json = Jason.encode!(get_in(project, ["definitions", "services"]) || [])

    Repo.transaction(fn ->
      SQL.query!(
        Repo,
        """
        insert into projects (
          name,
          path,
          last_synced_at,
          definitions_manifest_hash,
          workflows_json,
          services_json
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(name) do update set
          path = excluded.path,
          last_synced_at = excluded.last_synced_at,
          definitions_manifest_hash = excluded.definitions_manifest_hash,
          workflows_json = excluded.workflows_json,
          services_json = excluded.services_json
        """,
        [
          Map.fetch!(project, "name"),
          Map.fetch!(project, "path"),
          Map.get(project, "lastSyncedAt"),
          Map.get(project, "definitionsManifestHash"),
          workflows_json,
          services_json
        ]
      )
    end)

    get_project(Map.fetch!(project, "name"))
  end

  def remove_project(name) do
    project = get_project(name)

    if project do
      SQL.query!(Repo, "delete from projects where name = ?", [name])
    end

    project
  end

  def list_definitions(kind, project_name \\ nil)

  def list_definitions(kind, nil) do
    list_projects()
    |> Enum.flat_map(&definitions_for_kind(&1, kind))
  end

  def list_definitions(kind, project_name) do
    case get_project(project_name) do
      nil -> nil
      project -> definitions_for_kind(project, kind)
    end
  end

  def get_definition(project_name, kind, definition_name) do
    with project when not is_nil(project) <- get_project(project_name) do
      definitions_for_kind(project, kind)
      |> Enum.find(&(&1["name"] == definition_name))
    end
  end

  def create_workflow_run!(project_name, definition_name, input) do
    now = now_iso8601()
    run_id = "run_" <> Ecto.UUID.generate()
    event_id = "evt_" <> Ecto.UUID.generate()
    input_json = Jason.encode!(input || %{})

    Repo.transaction(fn ->
      SQL.query!(
        Repo,
        """
        insert into runs (
          id,
          project_name,
          definition_kind,
          definition_name,
          status,
          input_json,
          output_json,
          error_json,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [run_id, project_name, "workflow", definition_name, "pending", input_json, nil, nil, now, now]
      )

      SQL.query!(
        Repo,
        """
        insert into run_events (
          id,
          run_id,
          seq,
          event_type,
          body_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?)
        """,
        [
          event_id,
          run_id,
          1,
          "RunStarted",
          Jason.encode!(%{
            project: project_name,
            definitionKind: "workflow",
            definitionName: definition_name,
            input: input || %{}
          }),
          now
        ]
      )
    end)

    get_run(run_id)
  end

  def list_runs(project_name \\ nil) do
    query =
      if is_nil(project_name) do
        """
        select
          id,
          project_name,
          definition_kind,
          definition_name,
          status,
          input_json,
          output_json,
          error_json,
          created_at,
          updated_at
        from runs
        order by created_at desc
        """
      else
        """
        select
          id,
          project_name,
          definition_kind,
          definition_name,
          status,
          input_json,
          output_json,
          error_json,
          created_at,
          updated_at
        from runs
        where project_name = ?
        order by created_at desc
        """
      end

    args = if is_nil(project_name), do: [], else: [project_name]

    Repo
    |> SQL.query!(query, args)
    |> rows_to_maps()
    |> Enum.map(&run_from_row/1)
  end

  def get_run(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        project_name,
        definition_kind,
        definition_name,
        status,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      from runs
      where id = ?
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> run_from_row(row)
    end
  end

  def list_run_events(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        run_id,
        seq,
        event_type,
        body_json,
        created_at
      from run_events
      where run_id = ?
      order by seq asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&run_event_from_row/1)
  end

  defp definitions_for_kind(project, "workflow"), do: project["definitions"]["workflows"]
  defp definitions_for_kind(project, "service"), do: project["definitions"]["services"]

  defp project_from_row(row) do
    %{
      "name" => row["name"],
      "path" => row["path"],
      "lastSyncedAt" => row["last_synced_at"],
      "definitionsManifestHash" => row["definitions_manifest_hash"],
      "definitions" => %{
        "workflows" => decode_json_list(row["workflows_json"]),
        "services" => decode_json_list(row["services_json"])
      }
    }
  end

  defp run_from_row(row) do
    %{
      "id" => row["id"],
      "project" => row["project_name"],
      "definitionKind" => row["definition_kind"],
      "definitionName" => row["definition_name"],
      "status" => row["status"],
      "input" => decode_json_value(row["input_json"], %{}),
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp run_event_from_row(row) do
    %{
      "id" => row["id"],
      "runId" => row["run_id"],
      "seq" => row["seq"],
      "type" => row["event_type"],
      "body" => decode_json_value(row["body_json"], %{}),
      "createdAt" => row["created_at"]
    }
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row ->
      Enum.zip(columns, row) |> Map.new()
    end)
  end

  defp first_integer(%{rows: [[value]]}) when is_integer(value), do: value
  defp first_integer(_), do: 0

  defp decode_json_list(nil), do: []
  defp decode_json_list(value) when is_binary(value), do: Jason.decode!(value)

  defp decode_json_value(nil, fallback), do: fallback
  defp decode_json_value(value, _fallback) when is_binary(value), do: Jason.decode!(value)

  defp now_iso8601 do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end
end
