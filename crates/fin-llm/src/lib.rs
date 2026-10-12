// SPDX-License-Identifier: MIT-0
pub mod converse;
pub mod guardrail;
pub mod prompts;

pub use converse::{
    extract_json, guarded_converse, simple_converse, ToolHandler, ToolLoop, ToolLoopResult,
};
pub use guardrail::Guardrail;

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("bedrock error: {0}")]
    Bedrock(String),
    #[error("no text in model response")]
    NoText,
    #[error("json parse failed after retry: {0}")]
    JsonParse(String),
    #[error("tool loop exceeded {0} iterations")]
    LoopBudget(usize),
    #[error("tool execution failed: {0}")]
    Tool(String),
    /// The Bedrock guardrail blocked the call; carries the blocked message.
    #[error("bedrock guardrail intervened: {0}")]
    GuardrailIntervened(String),
}
