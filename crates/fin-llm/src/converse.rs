// SPDX-License-Identifier: MIT-0
use crate::guardrail::{intervened, user_blocks, Guardrail};
use crate::LlmError;
use aws_sdk_bedrockruntime::types::{
    ContentBlock, ConversationRole, Message, StopReason, SystemContentBlock, Tool,
    ToolConfiguration, ToolInputSchema, ToolResultBlock, ToolResultContentBlock, ToolSpecification,
    ToolUseBlock,
};
use aws_sdk_bedrockruntime::Client;
use aws_smithy_types::Document;

/// Single Converse call, no tools. Returns the model's text.
pub async fn simple_converse(
    client: &Client,
    model_id: &str,
    system: &str,
    user: &str,
) -> Result<String, LlmError> {
    guarded_converse(client, model_id, system, "", user, None).await
}

/// Single Converse call, no tools, with an optional guardrail. The user turn
/// is `trusted` followed by `untrusted`; with a guardrail only `untrusted` is
/// sent as guard content (the part the guardrail evaluates), without one the
/// request is exactly `simple_converse`'s. A block is
/// `LlmError::GuardrailIntervened`.
pub async fn guarded_converse(
    client: &Client,
    model_id: &str,
    system: &str,
    trusted: &str,
    untrusted: &str,
    guardrail: Option<&Guardrail>,
) -> Result<String, LlmError> {
    let msg = Message::builder()
        .role(ConversationRole::User)
        .set_content(Some(user_blocks(trusted, untrusted, guardrail)?))
        .build()
        .map_err(|e| LlmError::Bedrock(e.to_string()))?;
    let out = client
        .converse()
        .model_id(model_id)
        .system(SystemContentBlock::Text(system.to_string()))
        .messages(msg)
        .set_guardrail_config(guardrail.map(Guardrail::converse_config))
        .send()
        .await
        .map_err(|e| LlmError::Bedrock(e.into_service_error().to_string()))?;
    let text = first_text(&out);
    if guardrail.is_some() && intervened(&out.stop_reason, text.as_deref()) {
        return Err(LlmError::GuardrailIntervened(text.unwrap_or_default()));
    }
    text.ok_or(LlmError::NoText)
}

fn first_text(out: &aws_sdk_bedrockruntime::operation::converse::ConverseOutput) -> Option<String> {
    let msg = match out.output.as_ref()? {
        aws_sdk_bedrockruntime::types::ConverseOutput::Message(m) => m,
        _ => return None,
    };
    msg.content().iter().find_map(|b| match b {
        ContentBlock::Text(t) => Some(t.clone()),
        _ => None,
    })
}

/// Extract the first JSON object from model text (handles ```json fences
/// and leading prose).
pub fn extract_json(text: &str) -> Option<serde_json::Value> {
    let start = text.find('{')?;
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if escape {
            escape = false;
            continue;
        }
        match b {
            b'\\' if in_str => escape = true,
            b'"' => in_str = !in_str,
            b'{' if !in_str => depth += 1,
            b'}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&text[start..=i]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

/// A named tool the model may call. `run` receives the tool input as JSON
/// and returns JSON to feed back.
#[async_trait::async_trait]
pub trait ToolHandler: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn input_schema(&self) -> serde_json::Value;
    async fn run(&self, input: serde_json::Value) -> Result<serde_json::Value, String>;
}

pub struct ToolLoopResult {
    pub final_text: String,
    /// (tool_name, input, output) triplets, for the audit trail.
    pub transcript: Vec<(String, serde_json::Value, serde_json::Value)>,
}

pub struct ToolLoop<'a> {
    pub client: &'a Client,
    pub model_id: &'a str,
    pub system: &'a str,
    pub tools: Vec<Box<dyn ToolHandler>>,
    pub max_iterations: usize,
    /// Optional Bedrock guardrail. The loop sends no guard content, so the
    /// guardrail evaluates every message (user prompt, tool results, model
    /// turns) but not the system prompt. `None` leaves requests unchanged.
    pub guardrail: Option<&'a Guardrail>,
}

fn json_to_document(v: &serde_json::Value) -> Document {
    match v {
        serde_json::Value::Null => Document::Null,
        serde_json::Value::Bool(b) => Document::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                Document::Number(aws_smithy_types::Number::PosInt(u))
            } else if let Some(i) = n.as_i64() {
                Document::Number(aws_smithy_types::Number::NegInt(i))
            } else {
                Document::Number(aws_smithy_types::Number::Float(n.as_f64().unwrap_or(0.0)))
            }
        }
        serde_json::Value::String(s) => Document::String(s.clone()),
        serde_json::Value::Array(a) => Document::Array(a.iter().map(json_to_document).collect()),
        serde_json::Value::Object(o) => Document::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), json_to_document(v)))
                .collect(),
        ),
    }
}

fn document_to_json(d: &Document) -> serde_json::Value {
    match d {
        Document::Null => serde_json::Value::Null,
        Document::Bool(b) => serde_json::Value::Bool(*b),
        Document::Number(n) => match n {
            aws_smithy_types::Number::PosInt(u) => serde_json::json!(u),
            aws_smithy_types::Number::NegInt(i) => serde_json::json!(i),
            aws_smithy_types::Number::Float(f) => serde_json::json!(f),
        },
        Document::String(s) => serde_json::Value::String(s.clone()),
        Document::Array(a) => serde_json::Value::Array(a.iter().map(document_to_json).collect()),
        Document::Object(o) => serde_json::Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), document_to_json(v)))
                .collect(),
        ),
    }
}

impl<'a> ToolLoop<'a> {
    fn tool_config(&self) -> Result<ToolConfiguration, LlmError> {
        let mut builder = ToolConfiguration::builder();
        for t in &self.tools {
            builder = builder.tools(Tool::ToolSpec(
                ToolSpecification::builder()
                    .name(t.name())
                    .description(t.description())
                    .input_schema(ToolInputSchema::Json(json_to_document(&t.input_schema())))
                    .build()
                    .map_err(|e| LlmError::Bedrock(e.to_string()))?,
            ));
        }
        builder
            .build()
            .map_err(|e| LlmError::Bedrock(e.to_string()))
    }

    async fn dispatch(&self, tu: &ToolUseBlock) -> (serde_json::Value, serde_json::Value, bool) {
        let input = document_to_json(tu.input());
        for t in &self.tools {
            if t.name() == tu.name() {
                return match t.run(input.clone()).await {
                    // Bedrock requires toolResult json content to be an object,
                    // not an array/scalar — wrap anything else.
                    Ok(out) if out.is_object() => (input, out, false),
                    Ok(out) => (input, serde_json::json!({ "result": out }), false),
                    Err(e) => (input, serde_json::json!({ "error": e }), true),
                };
            }
        }
        (
            input,
            serde_json::json!({ "error": format!("unknown tool {}", tu.name()) }),
            true,
        )
    }

    pub async fn run(&self, user_prompt: &str) -> Result<ToolLoopResult, LlmError> {
        let config = self.tool_config()?;
        let mut messages: Vec<Message> = vec![Message::builder()
            .role(ConversationRole::User)
            .content(ContentBlock::Text(user_prompt.to_string()))
            .build()
            .map_err(|e| LlmError::Bedrock(e.to_string()))?];
        let mut transcript = Vec::new();

        for _ in 0..self.max_iterations {
            let out = self
                .client
                .converse()
                .model_id(self.model_id)
                .system(SystemContentBlock::Text(self.system.to_string()))
                .set_messages(Some(messages.clone()))
                .tool_config(config.clone())
                .set_guardrail_config(self.guardrail.map(Guardrail::converse_config))
                .send()
                .await
                .map_err(|e| LlmError::Bedrock(e.into_service_error().to_string()))?;

            let assistant_msg = match out.output.as_ref() {
                Some(aws_sdk_bedrockruntime::types::ConverseOutput::Message(m)) => m.clone(),
                _ => return Err(LlmError::NoText),
            };
            messages.push(assistant_msg.clone());

            if self.guardrail.is_some() && out.stop_reason == StopReason::GuardrailIntervened {
                let text = assistant_msg.content().iter().find_map(|b| match b {
                    ContentBlock::Text(t) => Some(t.clone()),
                    _ => None,
                });
                return Err(LlmError::GuardrailIntervened(text.unwrap_or_default()));
            }

            if out.stop_reason != StopReason::ToolUse {
                let text = assistant_msg
                    .content()
                    .iter()
                    .find_map(|b| match b {
                        ContentBlock::Text(t) => Some(t.clone()),
                        _ => None,
                    })
                    .ok_or(LlmError::NoText)?;
                return Ok(ToolLoopResult {
                    final_text: text,
                    transcript,
                });
            }

            // Execute every requested tool, respond in one user message.
            let mut result_blocks = Vec::new();
            for block in assistant_msg.content() {
                if let ContentBlock::ToolUse(tu) = block {
                    let (input, output, is_error) = self.dispatch(tu).await;
                    tracing::info!(tool = tu.name(), %input, "tool call");
                    transcript.push((tu.name().to_string(), input, output.clone()));
                    let mut trb = ToolResultBlock::builder()
                        .tool_use_id(tu.tool_use_id())
                        .content(ToolResultContentBlock::Json(json_to_document(&output)));
                    if is_error {
                        trb = trb.status(aws_sdk_bedrockruntime::types::ToolResultStatus::Error);
                    }
                    result_blocks.push(ContentBlock::ToolResult(
                        trb.build().map_err(|e| LlmError::Bedrock(e.to_string()))?,
                    ));
                }
            }
            let mut user_msg = Message::builder().role(ConversationRole::User);
            for b in result_blocks {
                user_msg = user_msg.content(b);
            }
            messages.push(
                user_msg
                    .build()
                    .map_err(|e| LlmError::Bedrock(e.to_string()))?,
            );
        }
        Err(LlmError::LoopBudget(self.max_iterations))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_fenced_json() {
        let text = "Here is my analysis:\n```json\n{\"relevant\": true, \"score\": 0.8}\n```";
        let v = extract_json(text).unwrap();
        assert_eq!(v["relevant"], true);
    }

    #[test]
    fn extracts_nested_json_with_strings_containing_braces() {
        let text = r#"{"rationale": "uses {braces} inside", "assets": [{"symbol": "BTC"}]}"#;
        let v = extract_json(text).unwrap();
        assert_eq!(v["assets"][0]["symbol"], "BTC");
    }

    #[test]
    fn no_json_returns_none() {
        assert!(extract_json("no json here").is_none());
    }

    #[test]
    fn document_round_trip() {
        let v = serde_json::json!({"a": 1, "b": [true, "x"], "c": {"d": 0.5}});
        assert_eq!(document_to_json(&json_to_document(&v)), v);
    }
}
