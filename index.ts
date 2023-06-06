import { postEvent, _postData } from "./interface/postEvent";
import { jsonMessage } from "./interface/lineMessage";
import { contexts, embeddingResponse, gptResponse } from "./interface/chatGPT";

// const GPT_TOKEN = PropertiesService.getScriptProperties().getProperty('GPTKEY'); //ChatGPTのAPIキーを入れてください
// const LINE_TOKEN = PropertiesService.getScriptProperties().getProperty('LINEKEY');    // LINEのAPIキーを入れてください
// const SPREADSHEET = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEETKEY') as string);

const LINE_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const GPT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings';
const EMMODEL_NAME = 'text-embedding-ada-002';
const MODEL_NAME = 'gpt-3.5-turbo';
const MODEL_TEMP = 0.5;
const MAX_TOKENS = 512;
const MAX_CHAT = 10;

class LineBot {
    GPT_TOKEN;
    LINE_TOKEN;
    SPREADSHEET;
    CHAT_LENGTH;

    constructor(GPTKEY:any,LINEKEY:any,SPREADSHEET:any,CHATLENGTH:number) {
        this.GPT_TOKEN = GPTKEY; //ChatGPTのAPIキーを入れてください
        this.LINE_TOKEN = LINEKEY;    // LINEのAPIキーを入れてください
        this.SPREADSHEET = SpreadsheetApp.openById(SPREADSHEET);
        this.CHAT_LENGTH = CHATLENGTH;
    }

    // postの処理
    async post(e: postEvent) {
        try {
            // LINEからPOSTされるJSON形式のデータをGASで扱える形式(JSオブジェクト)に変換
            const json = JSON.parse(e.postData.contents) as jsonMessage;
            // LINE側へ応答するためのトークンを作成(LINEからのリクエストに入っているので、それを取得する)
            const reply_token = json.events[0].replyToken;
            if (typeof reply_token === 'undefined') {
                return;
            }

            // LINEから送られてきたメッセージを取得
            const user_message = json.events[0].message.text;
            this.setLog(`${json.events[0].source.userId}：メッセージが送信されました。`);

            // userIDごとにチャット履歴があるか確認する。
            let messages = await this.chat(`${json.events[0].source.userId}:user`, user_message);
            if (user_message !== "削除。") {
                // 人格の指定
                const exist = this.checkSheetExists("system");
                let system = {
                    'role': "system",
                    'content': ""
                }
                if (exist) {
                    system.content = this.getSystem();
                    this.setLog(system);
                }

                if (!messages) {
                    messages = [
                        system,
                        { 'role': "user", 'content': user_message }
                    ]
                    this.setLog(messages);

                } else {
                    messages.unshift(system);
                }

                const headers = {
                    'Authorization': 'Bearer ' + this.GPT_TOKEN,
                    'Content-type': 'application/json',
                    'X-Slack-No-Retry': '1'
                };
                // リクエストオプション
                const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
                    'method': 'post',
                    'muteHttpExceptions': true,
                    'headers': headers,
                    'payload': JSON.stringify({
                        'model': MODEL_NAME,        // 使用するGPTモデル
                        'max_tokens': MAX_TOKENS,   // レスポンストークンの最大値(最大4,096)
                        'temperature': MODEL_TEMP,  // 応答の多様性(0-1)※数値が大きいほどランダムな応答になる
                        'messages': messages
                    })
                };
                // HTTPリクエストでChatGPTのAPIを呼び出す
                const res = JSON.parse(UrlFetchApp.fetch(GPT_ENDPOINT, options).getContentText()) as gptResponse;
                // ChatGPTから返却されたメッセージを応答メッセージとしてLINEに返す
                this.lineReply(json, res.choices[0].message.content.trimStart());

                if (!user_message.includes("[制約]")) {
                    this.chat(`${json.events[0].source.userId}:assistant`, res.choices[0].message.content.trimStart());
                }
            } else {
                this.lineReply(json, "チャット履歴が削除されました。");
            }

        } catch (err) {
            this.setLog(err);
        }
    }

    // Lineへの
    private lineReply(json: jsonMessage, replyText: string) {

        // 応答用のメッセージを作成
        const message = {
            "replyToken": json.events[0].replyToken,
            "messages": [{
                "type": "text",         // メッセージのタイプ(画像、テキストなど)
                "text": replyText
            }] // メッセージの内容
        };
        // LINE側へデータを返す際に必要となる情報
        const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
            "method": "post",
            "headers": {
                "Content-Type": "application/json; charset=UTF-8",  // JSON形式を指定、LINEの文字コードはUTF-8
                "Authorization": "Bearer " + this.LINE_TOKEN           // 認証タイプはBearer(トークン利用)、アクセストークン
            },
            "payload": JSON.stringify(message)                    // 応答文のメッセージをJSON形式に変換する
        };
        // LINEへ応答メッセージを返す
        UrlFetchApp.fetch(LINE_ENDPOINT, options);
    }

    private async chat(userID: string, newChat: string): Promise<void | { role: string; content: string }[]> {
        // return new Promise(async (resolve, reject) => {
        const chatVal = [];
        const rowIndices = [];
        const exists = this.checkSheetExists(userID.split(":")[0]);
        let chatSheet: GoogleAppsScript.Spreadsheet.Sheet;
        if (exists) {
            chatSheet = this.SPREADSHEET.getSheetByName(userID.split(":")[0]) as GoogleAppsScript.Spreadsheet.Sheet;
        } else {
            this.createNewSheetAtTop(userID.split(":")[0])
            chatSheet = this.SPREADSHEET.getSheetByName(userID.split(":")[0]) as GoogleAppsScript.Spreadsheet.Sheet;
        }
        let chatLastRow = chatSheet.getLastRow();
        let userIDArr = chatSheet.getRange(2, 1, chatLastRow, 1).getValues(); // チャット履歴からすべてのuserIDを取得

        // 今回のメッセージの内容を追加
        if (newChat !== "削除。" && !newChat.includes("[制約]")) {
            let now = new Date();
            let jpTime = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
            chatSheet.getRange(chatLastRow + 1, 1).setValue(userID); // userID
            chatSheet.getRange(chatLastRow + 1, 2).setValue(jpTime); // chat出力時間
            chatSheet.getRange(chatLastRow + 1, 3).setValue(newChat); // chatの出力
        }

        chatLastRow = chatSheet.getLastRow();
        userIDArr = chatSheet.getRange(2, 1, chatLastRow, 1).getValues(); // チャット履歴からすべてのuserIDを取得

        // 通常のチャットのやり取り
        if (!newChat.includes("[制約]")) {
            for (let i = 0; i < userIDArr.length; i++) {
                if (userIDArr[i].toString().split(":")[0] == userID.split(":")[0]) {
                    rowIndices.push({
                        "index": i + 2,
                        "role": userIDArr[i].toString().split(":")[1],
                    });
                }

                if (i == userIDArr.length - 1) {
                    if (rowIndices.length > 0) {
                        if (newChat == "削除。") {
                            for (let ii = 0; ii < rowIndices.length; ii++) {
                                // 該当のuserIDのチャットをクリア
                                chatSheet.getRange(rowIndices[ii].index, 1).clearContent();
                                chatSheet.getRange(rowIndices[ii].index, 2).clearContent();
                                chatSheet.getRange(rowIndices[ii].index, 3).clearContent();
                                // if (ii == rowIndices.length - 1) {
                                //     resolve();
                                // }
                            }
                        } else {
                            let chatLog = rowIndices.slice(-this.CHAT_LENGTH);
                            for (let ii = 0; ii < chatLog.length; ii++) {
                                chatVal.push({ 'role': chatLog[ii].role, 'content': chatSheet.getRange(chatLog[ii].index, 3, 1, 1).getValue() });
                                this.setLog(chatLog[ii].role)
                                this.setLog(chatSheet.getRange(chatLog[ii].index, 3, 1, 1).getValue())
                                if (ii == chatLog.length - 1) {
                                    return (chatVal);
                                }
                            }
                        }
                    } else {
                        // resolve();
                    }
                }
            }
        } else {
            const embeddingSheet = this.SPREADSHEET.getSheetByName("embedding") as GoogleAppsScript.Spreadsheet.Sheet;
            const embeddingLastRow = embeddingSheet.getLastRow();
            const embeddingLastColumn = embeddingSheet.getLastColumn();
            let knowLedges = [];
            for (let i = 2; i <= embeddingLastRow; i++) {
                knowLedges.push({
                    text: embeddingSheet.getRange(i, 2).getValue() as string,
                    vector: embeddingSheet.getRange(i, 3, 1, embeddingLastColumn).getValues()[0] as number[]
                });
                if (i == embeddingLastRow) {
                    let message = await this.createMessage(knowLedges, newChat);
                    return (message);
                }
            };
        }
        // });
    }

    private checkSheetExists(sheetName: string) {
        let sheets = this.SPREADSHEET.getSheets();

        for (let i = 0; i < sheets.length; i++) {
            if (sheets[i].getName() == sheetName) {
                return true;
            }
        }

        return false;
    }

    // シートの作成
    private createNewSheetAtTop(sheetName: string): void {
        // return new Promise((resolve, reject) => {
        let newSheet = this.SPREADSHEET.insertSheet(0);
        newSheet.setName(sheetName);
        newSheet.getRange(1, 1, 1, 3).setValues([["userID", "日時", "内容"]]);
        // resolve();
        // })
    }

    // system
    private getSystem(): string {
        let systemSheet = this.SPREADSHEET.getSheetByName("system") as GoogleAppsScript.Spreadsheet.Sheet;
        let systemLastRow = systemSheet.getLastRow();
        let systemContent = systemSheet.getRange(2, 1, systemLastRow, 1).getValues(); // system
        let content = "";
        systemContent.forEach((con, i) => {
            if (i !== systemContent.length - 1) {
                content += con[0] + "\n";
            }
        })
        return content;
    }

    // ログの出力
    private setLog(val: string | unknown) {
        const logSheet = this.SPREADSHEET.getSheetByName('log') as GoogleAppsScript.Spreadsheet.Sheet;
        const logLastRow = logSheet.getLastRow();
        let now = new Date();
        let jpTime = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
        logSheet.getRange(logLastRow + 1, 1).setValue(jpTime); // ログ時間出力
        logSheet.getRange(logLastRow + 1, 2).setValue(val); // ログの出力
    }

    // 質問をベクトル化
    private async createEmbedding(input: string) {
        try {
            const headers = {
                'Authorization': 'Bearer ' + this.GPT_TOKEN,
                'Content-type': 'application/json',
            };
            // リクエストオプション
            const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
                'method': 'post',
                'muteHttpExceptions': true,
                'headers': headers,
                'payload': JSON.stringify({
                    'model': EMMODEL_NAME,
                    'input': input
                })
            };
            // HTTPリクエストでChatGPTのAPIを呼び出す
            const res = JSON.parse(UrlFetchApp.fetch(EMBEDDING_ENDPOINT, options).getContentText()) as embeddingResponse;
            return res.data[0].embedding;
        } catch (e) {
            console.log(e)
            throw e
        }
    }

    // 前提知識と質問の内積を計算
    private async getRelevantContexts(contexts: contexts[], message: string) {
        // 前提知識の配列ベクトルと質問文ベクトルの内積を計算
        function dot(a: number[], b: number[]): number {
            return a.map((x, i) => {
                return a[i] * b[i];
            }).reduce((m, n) => {
                return m + n;
            })
        }

        const messageVec = await this.createEmbedding(message);

        return contexts.map((context) => {
            return {
                ...context,
                similarity: dot(messageVec, context.vector)
            }
        }).sort((a, b) => {
            return b.similarity - a.similarity
        }).slice(0, 3).map((i) => {
            return i.text
        })
    }


    private createMessage(knowLedges: contexts[], input: string): Promise<{ role: string; content: string }[]> {
        return new Promise(async (resolve, reject) => {
            try {
                const relevanceList = await this.getRelevantContexts(knowLedges, input);
                const prompt =
                    `以下の制約条件に従って、株式会社エンラプトのお問い合わせ窓口チャットボットとしてロールプレイをします。
  ---
  # 制約条件:
  - 制約情報を基に質問文に対する回答文を生成してください。
  - 回答は見出し、箇条書き、表などを使って人間が読みやすく表現してください。
  
  ---
  # 制約情報:
  ${relevanceList.join('\n\n')}
  
  ---
  # 質問文:
  ${input}
  
  ---
  # 回答文:
  `
                resolve([{ role: "user", content: prompt }]);
            } catch (error) {
                this.setLog(error);
            }
        });
    }
}

function getClass() { return LineBot } // クラスを取得する

// LINEからPOSTリクエストが渡されてきたときに実行される処理
// async function doPost(e: postEvent) {
//     try {
//         // LINEからPOSTされるJSON形式のデータをGASで扱える形式(JSオブジェクト)に変換
//         const json = JSON.parse(e.postData.contents) as jsonMessage;
//         // LINE側へ応答するためのトークンを作成(LINEからのリクエストに入っているので、それを取得する)
//         const reply_token = json.events[0].replyToken;
//         if (typeof reply_token === 'undefined') {
//             return;
//         }

//         // LINEから送られてきたメッセージを取得
//         const user_message = json.events[0].message.text;
//         setLog(`${json.events[0].source.userId}：メッセージが送信されました。`);

//         // userIDごとにチャット履歴があるか確認する。
//         let messages = await chat(`${json.events[0].source.userId}:user`, user_message);

//         if (user_message !== "削除。") {
//             // 人格の指定
//             const exist = checkSheetExists("system");
//             let system = {
//                 role: "system",
//                 content: ""
//             }
//             if (exist) {
//                 system.content = getSystem();
//             }

//             if (!messages) {
//                 messages = [
//                     system,
//                     { role: "user", content: `${user_message}` }
//                 ]
//             } else {
//                 messages.unshift(system);
//             }

//             const headers = {
//                 'Authorization': 'Bearer ' + GPT_TOKEN,
//                 'Content-type': 'application/json',
//                 'X-Slack-No-Retry': '1'
//             };
//             // リクエストオプション
//             const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
//                 'method': 'post',
//                 'muteHttpExceptions': true,
//                 'headers': headers,
//                 'payload': JSON.stringify({
//                     'model': MODEL_NAME,        // 使用するGPTモデル
//                     'max_tokens': MAX_TOKENS,   // レスポンストークンの最大値(最大4,096)
//                     'temperature': MODEL_TEMP,  // 応答の多様性(0-1)※数値が大きいほどランダムな応答になる
//                     'messages': messages
//                 })
//             };
//             // HTTPリクエストでChatGPTのAPIを呼び出す
//             const res = JSON.parse(UrlFetchApp.fetch(GPT_ENDPOINT, options).getContentText()) as gptResponse;
//             // ChatGPTから返却されたメッセージを応答メッセージとしてLINEに返す
//             lineReply(json, res.choices[0].message.content.trimStart());

//             if (!user_message.includes("[制約]")) {
//                 chat(`${json.events[0].source.userId}:assistant`, res.choices[0].message.content.trimStart());
//             }
//         } else {
//             lineReply(json, "チャット履歴が削除されました。");
//         }

//     } catch (err) {
//         setLog(err);
//     }
// }

// LINEへの応答
// function lineReply(json: jsonMessage, replyText: string) {

//     // 応答用のメッセージを作成
//     const message = {
//         "replyToken": json.events[0].replyToken,
//         "messages": [{
//             "type": "text",         // メッセージのタイプ(画像、テキストなど)
//             "text": replyText
//         }] // メッセージの内容
//     };
//     // LINE側へデータを返す際に必要となる情報
//     const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
//         "method": "post",
//         "headers": {
//             "Content-Type": "application/json; charset=UTF-8",  // JSON形式を指定、LINEの文字コードはUTF-8
//             "Authorization": "Bearer " + LINE_TOKEN           // 認証タイプはBearer(トークン利用)、アクセストークン
//         },
//         "payload": JSON.stringify(message)                    // 応答文のメッセージをJSON形式に変換する
//     };
//     // LINEへ応答メッセージを返す
//     UrlFetchApp.fetch(LINE_ENDPOINT, options);
// }

// async function chat(userID: string, newChat: string): Promise<void | { role: string; content: string }[]> {
//     // return new Promise(async (resolve, reject) => {
//     const chatVal = [];
//     const rowIndices = [];
//     const exists = checkSheetExists(userID.split(":")[0]);
//     let chatSheet: GoogleAppsScript.Spreadsheet.Sheet;
//     if (exists) {
//         chatSheet = SPREADSHEET.getSheetByName(userID.split(":")[0]) as GoogleAppsScript.Spreadsheet.Sheet;
//     } else {
//         createNewSheetAtTop(userID.split(":")[0])
//         chatSheet = SPREADSHEET.getSheetByName(userID.split(":")[0]) as GoogleAppsScript.Spreadsheet.Sheet;
//     }
//     let chatLastRow = chatSheet.getLastRow();
//     let userIDArr = chatSheet.getRange(2, 1, chatLastRow, 1).getValues(); // チャット履歴からすべてのuserIDを取得

//     // 今回のメッセージの内容を追加
//     if (newChat !== "削除。" && !newChat.includes("[制約]")) {
//         let now = new Date();
//         let jpTime = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
//         chatSheet.getRange(chatLastRow + 1, 1).setValue(userID); // userID
//         chatSheet.getRange(chatLastRow + 1, 2).setValue(jpTime); // chat出力時間
//         chatSheet.getRange(chatLastRow + 1, 3).setValue(newChat); // chatの出力
//     }

//     // 通常のチャットのやり取り
//     if (!newChat.includes("[制約]")) {
//         for (let i = 0; i < userIDArr.length; i++) {
//             if (userIDArr[i].toString().split(":")[0] == userID.split(":")[0]) {
//                 rowIndices.push({
//                     "index": i + 2,
//                     "role": userIDArr[i].toString().split(":")[1],
//                 });
//             }

//             if (i == userIDArr.length - 1) {
//                 if (rowIndices.length > 0) {
//                     if (newChat == "削除。") {
//                         for (let ii = 0; ii < rowIndices.length; ii++) {
//                             // 該当のuserIDのチャットをクリア
//                             chatSheet.getRange(rowIndices[ii].index, 1).clearContent();
//                             chatSheet.getRange(rowIndices[ii].index, 2).clearContent();
//                             chatSheet.getRange(rowIndices[ii].index, 3).clearContent();
//                             // if (ii == rowIndices.length - 1) {
//                             //     resolve();
//                             // }
//                         }
//                     } else {
//                         for (let ii = 0; ii < rowIndices.length; ii++) {
//                             chatVal.push({ 'role': rowIndices[ii].role, 'content': `"${chatSheet.getRange(rowIndices[ii].index, 3, 1, 1).getValue()}"` });
//                             if (ii == rowIndices.length - 1) {
//                                 return (chatVal);
//                             }
//                         }
//                     }
//                 } else {
//                     // resolve();
//                 }
//             }
//         }
//     } else {
//         const embeddingSheet = SPREADSHEET.getSheetByName("embedding") as GoogleAppsScript.Spreadsheet.Sheet;
//         const embeddingLastRow = embeddingSheet.getLastRow();
//         const embeddingLastColumn = embeddingSheet.getLastColumn();
//         let knowLedges = [];
//         for (let i = 2; i <= embeddingLastRow; i++) {
//             knowLedges.push({
//                 text: embeddingSheet.getRange(i, 2).getValue() as string,
//                 vector: embeddingSheet.getRange(i, 3, 1, embeddingLastColumn).getValues()[0] as number[]
//             });
//             if (i == embeddingLastRow) {
//                 let message = await createMessage(knowLedges, newChat);
//                 return (message);
//             }
//         };
//     }
//     // });
// }

// シートの検索
// function checkSheetExists(sheetName: string) {
//     let sheets = SPREADSHEET.getSheets();

//     for (let i = 0; i < sheets.length; i++) {
//         if (sheets[i].getName() == sheetName) {
//             return true;
//         }
//     }

//     return false;
// }

// // シートの作成
// function createNewSheetAtTop(sheetName: string): void {
//     // return new Promise((resolve, reject) => {
//     let newSheet = SPREADSHEET.insertSheet(0);
//     newSheet.setName(sheetName);
//     newSheet.getRange(1, 1, 1, 3).setValues([["userID", "日時", "内容"]]);
//     // resolve();
//     // })
// }

// // system
// function getSystem(): string {
//     let systemSheet = SPREADSHEET.getSheetByName("system") as GoogleAppsScript.Spreadsheet.Sheet;
//     let systemLastRow = systemSheet.getLastRow();
//     let systemContent = systemSheet.getRange(2, 1, systemLastRow, 2).getValues(); // system
//     let content = "";
//     systemContent.forEach((con, i) => {
//         if (i !== systemContent.length - 1) {
//             content += con[0] + con[1] + "\n";
//         }
//     })
//     return content;
// }

// // ログの出力
// function setLog(val: string | unknown) {
//     const logSheet = SPREADSHEET.getSheetByName('log') as GoogleAppsScript.Spreadsheet.Sheet;
//     const logLastRow = logSheet.getLastRow();
//     let now = new Date();
//     let jpTime = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
//     logSheet.getRange(logLastRow + 1, 1).setValue(jpTime); // ログ時間出力
//     logSheet.getRange(logLastRow + 1, 2).setValue(val); // ログの出力
// }

// // 質問をベクトル化
// async function createEmbedding(input: string) {
//     try {
//         const headers = {
//             'Authorization': 'Bearer ' + GPT_TOKEN,
//             'Content-type': 'application/json',
//         };
//         // リクエストオプション
//         const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
//             'method': 'post',
//             'muteHttpExceptions': true,
//             'headers': headers,
//             'payload': JSON.stringify({
//                 'model': EMMODEL_NAME,
//                 'input': input
//             })
//         };
//         // HTTPリクエストでChatGPTのAPIを呼び出す
//         const res = JSON.parse(UrlFetchApp.fetch(EMBEDDING_ENDPOINT, options).getContentText()) as embeddingResponse;
//         return res.data[0].embedding;
//     } catch (e) {
//         console.log(e)
//         throw e
//     }
// }

// // 前提知識と質問の内積を計算
// async function getRelevantContexts(contexts: contexts[], message: string) {
//     // 前提知識の配列ベクトルと質問文ベクトルの内積を計算
//     function dot(a: number[], b: number[]): number {
//         return a.map((x, i) => {
//             return a[i] * b[i];
//         }).reduce((m, n) => {
//             return m + n;
//         })
//     }

//     const messageVec = await createEmbedding(message);

//     return contexts.map((context) => {
//         return {
//             ...context,
//             similarity: dot(messageVec, context.vector)
//         }
//     }).sort((a, b) => {
//         return b.similarity - a.similarity
//     }).slice(0, 3).map((i) => {
//         return i.text
//     })
// }


// function createMessage(knowLedges: contexts[], input: string): Promise<{ role: string; content: string }[]> {
//     return new Promise(async (resolve, reject) => {
//         try {
//             const relevanceList = await getRelevantContexts(knowLedges, input);
//             const prompt =
//                 `以下の制約条件に従って、株式会社エンラプトのお問い合わせ窓口チャットボットとしてロールプレイをします。
//   ---
//   # 制約条件:
//   - 制約情報を基に質問文に対する回答文を生成してください。
//   - 回答は見出し、箇条書き、表などを使って人間が読みやすく表現してください。
  
//   ---
//   # 制約情報:
//   ${relevanceList.join('\n\n')}
  
//   ---
//   # 質問文:
//   ${input}
  
//   ---
//   # 回答文:
//   `
//             resolve([{ role: "user", content: prompt }]);
//         } catch (error) {
//             setLog(error);
//         }
//     });
// }