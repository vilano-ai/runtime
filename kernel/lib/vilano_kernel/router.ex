defmodule VilanoKernel.Router do
  @moduledoc false

  use Plug.ErrorHandler
  use Plug.Router

  alias VilanoKernel.Router.Auth
  alias VilanoKernel.Router.LeaseHandlers
  alias VilanoKernel.Router.PublicHandlers
  alias VilanoKernel.Router.Support
  import VilanoKernel.Router.Support

  plug(:match)

  plug(Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason
  )

  plug(:authenticate_request)
  plug(:dispatch)

  get "/v1/status" do
    PublicHandlers.status(conn)
  end

  get "/v1/admin/runtime-debug" do
    PublicHandlers.runtime_debug(conn)
  end

  defp authenticate_request(conn, _opts) do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    Auth.authenticate_request(conn, runtime)
  end

  post "/v1/admin/shutdown" do
    PublicHandlers.shutdown(conn)
  end

  get "/v1/admin/project-snapshots" do
    PublicHandlers.project_snapshots(conn)
  end

  get "/v1/projects" do
    PublicHandlers.list_projects(conn)
  end

  post "/v1/projects" do
    PublicHandlers.create_project(conn)
  end

  get "/v1/projects/:name" do
    PublicHandlers.get_project(conn, name)
  end

  post "/v1/projects/:name/sync" do
    PublicHandlers.sync_project(conn, name)
  end

  delete "/v1/projects/:name" do
    PublicHandlers.delete_project(conn, name)
  end

  post "/v1/projects/:name/purge-runtime" do
    PublicHandlers.purge_project_runtime(conn, name)
  end

  get "/v1/workflows" do
    PublicHandlers.list_workflows(conn)
  end

  get "/v1/services" do
    PublicHandlers.list_services(conn)
  end

  get "/v1/service-runs" do
    PublicHandlers.list_service_runs(conn)
  end

  get "/v1/workflows/:project/:name" do
    PublicHandlers.get_workflow_definition(conn, project, name)
  end

  get "/v1/services/:project/:name/runs/:service_key" do
    PublicHandlers.inspect_service_run(conn, project, name, service_key)
  end

  get "/v1/service-envelopes/:id" do
    PublicHandlers.get_service_envelope(conn, id)
  end

  post "/v1/activations/lease" do
    LeaseHandlers.lease_activation(conn)
  end

  post "/v1/leases/:lease_id/heartbeat" do
    LeaseHandlers.heartbeat(conn, lease_id)
  end

  get "/v1/leases/:lease_id/status" do
    LeaseHandlers.lease_status(conn, lease_id)
  end

  get "/v1/leases/:lease_id/runs/:id/status" do
    LeaseHandlers.related_run_status(conn, lease_id, id)
  end

  post "/v1/leases/:lease_id/runs/:id/monitor" do
    LeaseHandlers.monitor_run(conn, lease_id, id)
  end

  post "/v1/leases/:lease_id/runs/:id/link" do
    LeaseHandlers.link_run(conn, lease_id, id)
  end

  post "/v1/leases/:lease_id/trap-exits" do
    LeaseHandlers.trap_exits(conn, lease_id)
  end

  post "/v1/leases/:lease_id/runs/:id/signals" do
    LeaseHandlers.signal_child_run(conn, lease_id, id)
  end

  post "/v1/leases/:lease_id/complete" do
    LeaseHandlers.complete_run(conn, lease_id)
  end

  post "/v1/leases/:lease_id/fail" do
    LeaseHandlers.fail_run(conn, lease_id)
  end

  post "/v1/leases/:lease_id/steps/resolve" do
    LeaseHandlers.resolve_step(conn, lease_id)
  end

  post "/v1/leases/:lease_id/steps/complete" do
    LeaseHandlers.complete_step(conn, lease_id)
  end

  post "/v1/leases/:lease_id/steps/fail" do
    LeaseHandlers.fail_step(conn, lease_id)
  end

  post "/v1/leases/:lease_id/execs/resolve" do
    LeaseHandlers.resolve_exec(conn, lease_id)
  end

  post "/v1/leases/:lease_id/execs/complete" do
    LeaseHandlers.complete_exec(conn, lease_id)
  end

  post "/v1/leases/:lease_id/execs/fail" do
    LeaseHandlers.fail_exec(conn, lease_id)
  end

  post "/v1/leases/:lease_id/waits/sleep" do
    LeaseHandlers.resolve_sleep_wait(conn, lease_id)
  end

  post "/v1/leases/:lease_id/waits/signal" do
    LeaseHandlers.resolve_signal_wait(conn, lease_id)
  end

  post "/v1/leases/:lease_id/waits/exit" do
    LeaseHandlers.resolve_exit_wait(conn, lease_id)
  end

  post "/v1/leases/:lease_id/supervision/groups" do
    LeaseHandlers.resolve_supervision_group(conn, lease_id)
  end

  post "/v1/leases/:lease_id/supervision/groups/:group_id/members" do
    LeaseHandlers.resolve_supervised_spawn(conn, lease_id, group_id)
  end

  get "/v1/leases/:lease_id/supervision/groups/:group_id/members" do
    LeaseHandlers.list_supervision_members(conn, lease_id, group_id)
  end

  post "/v1/leases/:lease_id/supervision/groups/:group_id/members/:member_key/result" do
    LeaseHandlers.resolve_supervision_member_result_wait(conn, lease_id, group_id, member_key)
  end

  get "/v1/leases/:lease_id/supervision/groups/:group_id/members/:member_key/status" do
    LeaseHandlers.get_supervision_member_status(conn, lease_id, group_id, member_key)
  end

  post "/v1/leases/:lease_id/spawns/resolve" do
    LeaseHandlers.resolve_spawn(conn, lease_id)
  end

  post "/v1/leases/:lease_id/children/result" do
    LeaseHandlers.resolve_child_result_wait(conn, lease_id)
  end

  post "/v1/leases/:lease_id/services/send" do
    LeaseHandlers.resolve_service_send(conn, lease_id)
  end

  post "/v1/leases/:lease_id/services/lookup-singleton" do
    LeaseHandlers.lookup_singleton_service(conn, lease_id)
  end

  post "/v1/leases/:lease_id/pubsub/publish" do
    LeaseHandlers.publish_topic(conn, lease_id)
  end

  post "/v1/leases/:lease_id/pubsub/subscriptions" do
    LeaseHandlers.subscribe_topic(conn, lease_id)
  end

  post "/v1/leases/:lease_id/pubsub/subscriptions/delete" do
    LeaseHandlers.unsubscribe_topic(conn, lease_id)
  end

  post "/v1/leases/:lease_id/services/ask" do
    LeaseHandlers.resolve_service_ask(conn, lease_id)
  end

  post "/v1/leases/:lease_id/services/signal" do
    LeaseHandlers.resolve_service_signal(conn, lease_id)
  end

  post "/v1/leases/:lease_id/service-turns/:envelope_id/complete" do
    LeaseHandlers.complete_service_turn(conn, lease_id, envelope_id)
  end

  get "/v1/leases/:lease_id/service-turns/:envelope_id/mailbox" do
    LeaseHandlers.get_service_turn_mailbox(conn, lease_id, envelope_id)
  end

  post "/v1/leases/:lease_id/service-turns/:envelope_id/defer" do
    LeaseHandlers.defer_service_turn(conn, lease_id, envelope_id)
  end

  post "/v1/leases/:lease_id/service-turns/:envelope_id/reject" do
    LeaseHandlers.reject_service_turn(conn, lease_id, envelope_id)
  end

  post "/v1/leases/:lease_id/service-turns/:envelope_id/fail" do
    LeaseHandlers.fail_service_turn(conn, lease_id, envelope_id)
  end

  post "/v1/services/ensure" do
    PublicHandlers.ensure_service(conn)
  end

  post "/v1/services/:project/:name/runs/:service_key/send" do
    PublicHandlers.enqueue_service_send(conn, project, name, service_key)
  end

  post "/v1/services/:project/:name/runs/:service_key/ask" do
    PublicHandlers.enqueue_service_ask(conn, project, name, service_key)
  end

  post "/v1/services/:project/:name/runs/:service_key/signal" do
    PublicHandlers.enqueue_service_signal(conn, project, name, service_key)
  end

  post "/v1/services/:project/:name/runs/:service_key/stop" do
    PublicHandlers.stop_service(conn, project, name, service_key)
  end

  post "/v1/runs" do
    PublicHandlers.create_run(conn)
  end

  get "/v1/runs" do
    PublicHandlers.list_runs(conn)
  end

  get "/v1/runs/:id" do
    PublicHandlers.inspect_run(conn, id)
  end

  get "/v1/runs/:id/replay" do
    PublicHandlers.replay_run(conn, id)
  end

  post "/v1/runs/:id/cancel" do
    PublicHandlers.cancel_run(conn, id)
  end

  post "/v1/runs/:id/signals" do
    PublicHandlers.signal_run(conn, id)
  end

  match _ do
    send_error(conn, 404, "not_found", "Unknown endpoint: #{conn.method} #{conn.request_path}")
  end

  @impl Plug.ErrorHandler
  def handle_errors(conn, %{reason: reason}) do
    message =
      cond do
        is_exception(reason) -> Exception.message(reason)
        true -> inspect(reason)
      end

    Support.send_json(conn, conn.status || 500, %{
      ok: false,
      error: %{code: "internal_error", message: message}
    })
  end
end
