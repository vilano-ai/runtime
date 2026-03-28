defmodule VilanoKernel.Router.ServiceHandlers do
  @moduledoc false

  alias VilanoKernel.Storage

  import VilanoKernel.Router.Support

  def inspect_service_run(conn, project, name, service_key) do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <-
           Storage.find_definition(project_record, "service", name),
         service_run when not is_nil(service_run) <-
           Storage.find_service_run(project, definition["name"], service_key) do
      _ = project_record
      send_run_inspect(conn, service_run["id"])
    else
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown service instance '#{name}/#{service_key}' in project '#{project}'"
        )
    end
  end

  def get_service_envelope(conn, id) do
    case Storage.find_service_envelope(id) do
      nil -> send_error(conn, 404, "not_found", "Unknown service envelope: #{id}")
      envelope -> send_json(conn, 200, %{ok: true, envelope: envelope})
    end
  end

  def ensure_service(conn) do
    service = fetch_required_string(conn.body_params, "service")
    service_key = fetch_required_string(conn.body_params, "serviceKey")
    must_exist = Map.get(conn.body_params, "mustExist", false) == true

    requested_lease_id =
      case Map.get(conn.body_params, "leaseId") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    effective_lease_id =
      case conn.assigns[:auth_scope] do
        :lease -> conn.assigns[:lease_id]
        _ -> requested_lease_id
      end

    if conn.assigns[:auth_scope] == :lease and conn.assigns[:lease_id] != requested_lease_id do
      send_error(
        conn,
        401,
        "unauthorized",
        "Lease token can only resolve services for its active lease"
      )
    else
      with {project_record, definition} when not is_nil(project_record) <-
             resolve_service_definition(conn.body_params, service),
           run <-
             Storage.ensure_service_run!(
               project_record,
               definition,
               service_key,
               Map.get(conn.body_params, "keyInput", %{}),
               effective_lease_id,
               must_exist
             ) do
        send_json(conn, 200, %{ok: true, run: run})
      else
        nil ->
          send_error(
            conn,
            404,
            "not_found",
            if(must_exist,
              do: "Unknown service instance '#{service}/#{service_key}'",
              else: "Unknown service '#{service}'"
            )
          )
      end
    end
  end

  def enqueue_service_send(conn, project, name, service_key) do
    enqueue_public_service_message(
      conn,
      project,
      name,
      service_key,
      "send",
      fetch_required_string(conn.body_params, "message")
    )
  end

  def enqueue_service_ask(conn, project, name, service_key) do
    enqueue_public_service_message(
      conn,
      project,
      name,
      service_key,
      "ask",
      fetch_required_string(conn.body_params, "message")
    )
  end

  def enqueue_service_signal(conn, project, name, service_key) do
    enqueue_public_service_message(
      conn,
      project,
      name,
      service_key,
      "signal",
      fetch_required_string(conn.body_params, "signal")
    )
  end

  def stop_service(conn, project, name, service_key) do
    with result when not is_nil(result) <- Storage.stop_service_run(project, name, service_key) do
      maybe_kill_managed_worker(result)

      send_json(conn, 200, %{
        ok: true,
        run: result["run"],
        stoppedEnvelopeCount: result["stoppedEnvelopeCount"],
        cancelledWaitCount: result["cancelledWaitCount"],
        cancelledChildRunCount: result["cancelledChildRunCount"],
        cancelledServiceAskCount: result["cancelledServiceAskCount"],
        hadInFlightTurn: result["hadInFlightTurn"]
      })
    else
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown service instance '#{name}/#{service_key}' in project '#{project}'"
        )
    end
  end

  defp enqueue_public_service_message(conn, project, name, service_key, kind, message_name) do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <-
           Storage.find_definition(project_record, "service", name),
         result <-
           Storage.enqueue_service_envelope!(
             project_record,
             definition,
             service_key,
             Map.get(conn.body_params, "keyInput", %{}),
             kind,
             message_name,
             Map.get(conn.body_params, "payload")
           ) do
      _ = project_record

      case result do
        %{"run" => run, "envelope" => envelope} ->
          send_json(conn, 200, %{ok: true, run: run, envelope: envelope})

        {:error, error} ->
          send_service_enqueue_error(conn, error)
      end
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown service '#{name}' in project '#{project}'")
    end
  end

  defp resolve_service_definition(body_params, service_name) do
    case Map.get(body_params, "leaseId") do
      lease_id when is_binary(lease_id) and lease_id != "" ->
        with run when not is_nil(run) <- Storage.get_active_run_by_lease(lease_id),
             definition when not is_nil(definition) <-
               find_definition_in_run(run, "service", service_name) do
          {
            %{
              "name" => run["project"],
              "path" => run["projectSnapshotPath"],
              "snapshotPath" => run["projectSnapshotPath"],
              "definitions" => run["projectDefinitions"] || %{"workflows" => [], "services" => []}
            },
            definition
          }
        end

      _ ->
        project = fetch_required_string(body_params, "project")

        with project_record when not is_nil(project_record) <- Storage.get_project(project),
             definition when not is_nil(definition) <-
               Storage.find_definition(project_record, "service", service_name) do
          {project_record, definition}
        end
    end
  end

  defp find_definition_in_run(run, kind, definition_name) do
    bucket =
      case kind do
        "workflow" -> get_in(run, ["projectDefinitions", "workflows"]) || []
        "service" -> get_in(run, ["projectDefinitions", "services"]) || []
      end

    Enum.find(bucket, &(&1["name"] == definition_name))
  end

  defp send_service_enqueue_error(conn, error) do
    case Map.get(error, "reason") do
      "service_overloaded" ->
        send_error(conn, 429, "service_overloaded", Map.fetch!(error, "message"))

      _ ->
        send_error(conn, 409, "service_stopped", Map.fetch!(error, "message"))
    end
  end
end
