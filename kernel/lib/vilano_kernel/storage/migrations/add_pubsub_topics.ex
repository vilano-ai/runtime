defmodule VilanoKernel.Storage.Migrations.AddPubsubTopics do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 13
  def name, do: "add_pubsub_topics"

  def up do
    SQL.query!(
      Repo,
      """
      create table if not exists topic_subscriptions (
        topic text not null,
        service_run_id text not null,
        signal_name text not null,
        created_at text not null,
        updated_at text not null,
        primary key (topic, service_run_id, signal_name)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_topic_publishes (
        caller_run_id text not null,
        op_key text not null,
        publish_id text not null,
        topic text not null,
        payload_json text,
        matched_count integer not null,
        enqueued_count integer not null,
        rejected_count integer not null,
        created_at text not null,
        updated_at text not null,
        primary key (caller_run_id, op_key),
        unique (publish_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists topic_subscriptions_topic_service_idx
      on topic_subscriptions(topic, service_run_id, updated_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_topic_publishes_caller_created_idx
      on run_topic_publishes(caller_run_id, created_at)
      """,
      []
    )
  end
end
