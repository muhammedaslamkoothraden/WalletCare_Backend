'use strict';

const axios = require('axios');

async function generateSummary(data, timeframe = 'weekly') {
  try {
    // 👉 If you want AI (OpenAI or any LLM)
    const prompt = `
User financial summary (${timeframe}):

Income: ${data.income}
Expense: ${data.expense}
Savings: ${data.netSavings}
Top categories: ${data.categories.map(c => c.name).join(', ')}

Write a short, friendly financial summary with advice.
    `;

    // 🔴 Replace with your AI provider
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    // 🟡 Fallback (IMPORTANT — never depend 100% on AI)
    return generateBasicSummary(data);
  }
}

// 🔥 Fallback summary (fast + reliable)
function generateBasicSummary(data) {
  const { income, expense, netSavings, categories } = data;

  let msg = `This period you earned ₹${income} and spent ₹${expense}. `;

  if (netSavings > 0) {
    msg += `Great! You saved ₹${netSavings}. `;
  } else {
    msg += `You overspent by ₹${Math.abs(netSavings)}. `;
  }

  if (categories?.length) {
    msg += `Top spending: ${categories[0].name}.`;
  }

  return msg;
}

module.exports = { generateSummary };