import os
import boto3
import streamlit as st
from typing import List, Dict

# Bedrockクライアントを初期化する関数
def initialize_bedrock_client():
    # 使用するリージョンと知識ベースIDを設定
    region = "us-west-2"
    kb_id = "L3ENSK42QL"
    # Bedrockクライアントを初期化
    client = boto3.client("bedrock-agent-runtime", region_name=region)
    return client, kb_id

# 知識ベースにクエリを送信し、回答をストリームで取得する関数
def query_knowledge_base(client, kb_id, input_text, ver, temperature, top_p, chat_history):
    # 直近の会話履歴を取得してフォーマット
    conversation_context = "\n".join([
        f"ユーザー: {msg['user']}\nアシスタント: {msg['assistant']}"
        for msg in chat_history[-3:]  # 直近3件の会話履歴を含める
    ])

    # 会話履歴と新しい質問を組み合わせたプロンプトを作成
    prompt_with_history = f"""
    これまでの会話：
    {conversation_context}
    
    新しい質問：
    {input_text}
    """

    # フィルタ設定（バージョンに基づく）
    filter = {
        "equals": {
            "key": "ver", 
            "value": str(ver),
        }
    }

    # Bedrockクライアントで知識ベースからの検索と生成を行う
    response = client.retrieve_and_generate_stream(
        input={"text": prompt_with_history},
        retrieveAndGenerateConfiguration={
            "knowledgeBaseConfiguration": {
                "generationConfiguration": {
                    "promptTemplate": {
                        "textPromptTemplate": """
                        以下の検索結果を参考に、これまでの会話の文脈を踏まえて回答してください：
                        '$search_results$'
                        回答フォーマット：
                        ---
                        【参照ドキュメント】
                        - 参照したドキュメントのタイトルを記載
                        - 参照したドキュメントのページ
                        【回答】
                        具体的な回答内容
                        ---
                        注意事項：
                        - 検索結果が存在する場合は、必ず参照したドキュメントのタイトルとどのページに記載されているかを記載すること
                        - 検索結果が存在しない場合は、「【参考情報】」と記載して回答すること
                        - 回答は上記のフォーマットに従って構造化すること
                        - 前の会話の文脈を考慮して回答すること
                        """
                    },
                    "inferenceConfig": {
                        "textInferenceConfig": {
                            "maxTokens": 4000,
                            "temperature": temperature,
                            "topP": top_p
                        }
                    }
                },
                "knowledgeBaseId": kb_id,
                "modelArn": "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
                "retrievalConfiguration": {
                    "vectorSearchConfiguration": {
                        "filter": filter,
                        "numberOfResults": 5,
                    }
                },
            },
            "type": "KNOWLEDGE_BASE",
        },
    )

    # ストリーム形式のレスポンスを返す
    return response.get("stream")

# 会話履歴を初期化する関数
def initialize_chat_history():
    if "messages" not in st.session_state:
        st.session_state.messages = []

# 会話履歴にメッセージを追加する関数
def add_message(role: str, content: str):
    st.session_state.messages.append({"role": role, "content": content})

# 会話履歴を表示する関数
def display_chat_messages():
    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])

# アプリケーションのメイン関数
def main():
    st.title("AWS Bedrock チャットボット")

    # Bedrockクライアントを初期化
    client, kb_id = initialize_bedrock_client()

    # 会話履歴を初期化
    initialize_chat_history()

    # サイドバー設定
    with st.sidebar:
        st.header("メタデータ")
        ver = st.selectbox("AWS CLI バージョン:", options=[2, 1], index=0)  # CLIバージョン選択

        st.subheader("パラメータ")
        temperature = st.slider("温度", min_value=0.0, max_value=1.0, value=0.1, step=0.1)  # 応答の多様性
        top_p = st.slider("トップ P", min_value=0.0, max_value=1.0, value=0.9, step=0.1)  # トップPサンプリング

        if st.button("会話をクリア"):
            st.session_state.messages = []  # 会話履歴をクリア
            st.rerun()

    # 会話履歴を表示
    display_chat_messages()

    # チャット入力欄の処理
    if prompt := st.chat_input("メッセージを入力してください"):
        # ユーザーからのメッセージを会話履歴に追加
        add_message("user", prompt)

        # ユーザーのメッセージを表示
        with st.chat_message("user"):
            st.markdown(prompt)

        # アシスタントの応答を生成して表示
        with st.chat_message("assistant"):
            message_placeholder = st.empty()  # 応答をリアルタイムで表示するためのプレースホルダ
            full_response = ""

            try:
                # 知識ベースからの応答を取得
                stream = query_knowledge_base(
                    client, 
                    kb_id, 
                    prompt, 
                    ver, 
                    temperature, 
                    top_p,
                    [{"user": msg["content"], "assistant": st.session_state.messages[i+1]["content"]}
                     for i, msg in enumerate(st.session_state.messages[:-1:2])]  # 過去の会話履歴をフォーマット
                )

                if stream:
                    for event in stream:
                        if "output" in event:
                            chunk = event['output']['text']  # ストリームの出力を受信
                            full_response += chunk
                            message_placeholder.markdown(full_response + "▌")  # レスポンスを逐次表示

                    message_placeholder.markdown(full_response)  # 最終応答を表示

                    # アシスタントの応答を会話履歴に追加
                    add_message("assistant", full_response)

            except Exception as e:
                st.error(f"エラーが発生しました: {str(e)}")  # エラー処理

# アプリケーションのエントリーポイント
if __name__ == "__main__":
    main()