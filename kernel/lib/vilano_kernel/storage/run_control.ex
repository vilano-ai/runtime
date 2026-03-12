defmodule VilanoKernel.Storage.RunControl do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{Infrastructure, Support}

  import Support

  def ensure_service_run_in_tx!(
        project,
        definition,
        service_key,
        key_input,
        now,
        caller_run_id \\ nil,
        lease_id \\ nil,
        must_exist \\ false
      ) do
    project_name = Map.fetch!(project, "name")
    definition_name = Map.fetch!(definition, "name")

    if is_binary(caller_run_id) and caller_run_id != "" and is_binary(lease_id) and lease_id != "" do
      ensure_fenced_run_ownership!(caller_run_id, lease_id, now)
    end

    service_run =
      case get_service_run(project_name, definition_name, service_key) do
        nil when must_exist ->
          nil

        nil ->
          run_id = deterministic_service_run_id(project_name, definition_name, service_key)
          definitions_json = Jason.encode!(Map.fetch!(project, "definitions"))

          SQL.query!(
            Repo,
            """
            insert or ignore into runs (
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
              lease_worker_id,
              lease_expires_at,
              input_json,
              output_json,
              error_json,
              created_at,
              updated_at
            ) values (?, ?, 'service', ?, ?, ?, ?, ?, ?, ?, 'idle', null, null, null, ?, null, null, ?, ?)
            """,
            [
              run_id,
              project_name,
              definition_name,
              Map.get(project, "snapshotPath") || Map.fetch!(project, "path"),
              definitions_json,
              Map.fetch!(definition, "file"),
              Map.fetch!(definition, "exportName"),
              Map.fetch!(definition, "runtimeKind"),
              Map.fetch!(definition, "sourceLanguage"),
              Jason.encode!(key_input || %{}),
              now,
              now
            ]
          )

          inserted_service_rows =
            write_changes!(
              """
              insert or ignore into service_runs (
                run_id,
                service_key,
                key_input_json,
                state_json,
                created_at,
                updated_at
              ) values (?, ?, ?, null, ?, ?)
              """,
              [run_id, service_key, Jason.encode!(key_input || %{}), now, now]
            )

          if inserted_service_rows == 1 do
            append_event!(
              run_id,
              "ServiceInstantiated",
              %{
                "serviceKey" => service_key,
                "definitionName" => definition_name,
                "keyInput" => key_input || %{}
              },
              now
            )
          end

          get_service_run(project_name, definition_name, service_key)

        service_run ->
          service_run
      end

    case service_run do
      nil ->
        nil

      resolved ->
        record_service_ref!(caller_run_id, resolved["id"], now)

        if is_binary(caller_run_id) and caller_run_id != "" and is_binary(lease_id) and
             lease_id != "" do
          ensure_fenced_run_ownership!(caller_run_id, lease_id, now)
        end

        resolved
    end
  end

  def get_run_by_lease(lease_id) do
    now = Infrastructure.now_iso8601()

    Repo
    |> SQL.query!(
      """
      select
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
      from runs
      where
        lease_id = ?
        and status in ('running', 'active')
        and lease_expires_at is not null
        and lease_expires_at >= ?
      """,
      [lease_id, now]
    )
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> run_from_row(row)
    end
  end

  def get_fenced_run_by_lease(lease_id, now) do
    case get_run_by_lease(lease_id) do
      nil ->
        nil

      run ->
        if acquire_lease_write_fence(run["id"], lease_id, now) do
          run
        else
          nil
        end
    end
  end

  def acquire_lease_write_fence(run_id, lease_id, now) do
    write_changes!(
      """
      update runs
      set updated_at = updated_at
      where
        id = ?
        and lease_id = ?
        and status in ('running', 'active')
        and lease_expires_at is not null
        and lease_expires_at >= ?
      """,
      [run_id, lease_id, now]
    ) == 1
  end

  def ensure_fenced_run_write!(run_id, lease_id, now, query, params) do
    if acquire_lease_write_fence(run_id, lease_id, now) do
      SQL.query!(Repo, query, params)
      :ok
    else
      Repo.rollback(:stale_candidate)
    end
  end

  def ensure_fenced_run_ownership!(run_id, lease_id, now) do
    if acquire_lease_write_fence(run_id, lease_id, now) do
      :ok
    else
      Repo.rollback(:stale_candidate)
    end
  end

  def ensure_fenced_related_write!(
        run_id,
        lease_id,
        now,
        query,
        params,
        expected_rows \\ 1
      ) do
    changed_rows =
      write_changes!(
        query,
        params ++ [run_id, lease_id, now]
      )

    if changed_rows == expected_rows do
      :ok
    else
      Repo.rollback(:stale_candidate)
    end
  end

  def lease_auth_token_valid?(lease_id, lease_auth_token)
      when is_binary(lease_id) and lease_id != "" and is_binary(lease_auth_token) and
             lease_auth_token != "" do
    now = Infrastructure.now_iso8601()

    Repo
    |> SQL.query!(
      """
      select 1
      from runs
      where
        lease_id = ?
        and lease_auth_token = ?
        and status in ('running', 'active')
        and lease_expires_at is not null
        and lease_expires_at >= ?
      limit 1
      """,
      [lease_id, lease_auth_token, now]
    )
    |> first_integer() == 1
  end

  def lease_auth_token_valid?(_lease_id, _lease_auth_token), do: false

  def ensure_run_activation_pinned!(run) do
    if activation_pinned?(run) do
      {:ok, run}
    else
      {:error, {:unresumable_candidate, run}}
    end
  end

  def activation_pinned?(run) do
    is_binary(run["projectSnapshotPath"]) and run["projectSnapshotPath"] != "" and
      is_map(run["definition"]) and
      is_binary(get_in(run, ["definition", "file"])) and get_in(run, ["definition", "file"]) != "" and
      is_binary(get_in(run, ["definition", "exportName"])) and
      get_in(run, ["definition", "exportName"]) != "" and
      is_binary(get_in(run, ["definition", "runtimeKind"])) and
      get_in(run, ["definition", "runtimeKind"]) != "" and
      is_binary(get_in(run, ["definition", "sourceLanguage"])) and
      get_in(run, ["definition", "sourceLanguage"]) != ""
  end

  def invalidate_unpinned_run!(%{"definitionKind" => "service"} = run, now) do
    _ =
      VilanoKernel.Storage.FailureRecovery.stop_service_run_instance!(
        get_service_run_by_id(run["id"]),
        legacy_run_error(),
        "missing_pinned_definition",
        now
      )

    :ok
  end

  def invalidate_unpinned_run!(run, now) do
    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'failed',
        lease_id = null,
        lease_auth_token = null,
        lease_worker_id = null,
        lease_expires_at = null,
        error_json = ?,
        updated_at = ?
      where id = ?
      """,
      [Jason.encode!(legacy_run_error()), now, run["id"]]
    )

    append_event!(run["id"], "RunFailed", %{"error" => legacy_run_error()}, now)
    VilanoKernel.Storage.AgentRelationships.wake_waiting_parents_for_child!(
      run["id"],
      "failed",
      legacy_run_error(),
      now
    )

    VilanoKernel.Storage.Supervision.maybe_apply_supervision_for_terminal_run!(run["id"], now)
    VilanoKernel.Storage.AgentRelationships.maybe_trigger_relationships_for_terminal_run!(run["id"], now)
    :ok
  end

  def legacy_run_error do
    %{
      "message" =>
        "Run cannot be resumed safely because this runtime did not record an immutable project snapshot and definition payload when it started",
      "reason" => "missing_pinned_definition"
    }
  end
end
