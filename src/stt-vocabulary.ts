/**
 * Stable spelling hints for bilingual speech recognition.
 *
 * Keep this list focused on proper nouns, brands, abbreviations and technical
 * phrases that are easy to mishear. Ordinary prose belongs in the language
 * model, not in an ever-growing speech vocabulary.
 */
export const STT_VOCABULARY = {
  localPlaces: [
    'Iowa', 'Des Moines', 'West Des Moines', 'Waukee', 'Ames', 'Ankeny',
    'Urbandale', 'Clive', 'Johnston', 'Altoona', 'Windsor Heights'
  ],
  shoppingAndServices: [
    'Target', 'Costco', 'Whole Foods Market', 'Hy-Vee', 'Fareway',
    "Trader Joe's", 'ALDI', 'Walmart', "Sam's Club", "Casey's",
    'UPS', 'USPS', 'FedEx', 'CVS Pharmacy', 'Walgreens'
  ],
  dataScienceAndTechnology: [
    'Power BI', 'SAS', 'Python', 'R', 'SQL', 'Jupyter Notebook', 'pandas',
    'NumPy', 'scikit-learn', 'PyTorch', 'TensorFlow', 'Tableau', 'Excel',
    'DAX', 'Power Query', 'ETL', 'API', 'JSON', 'TypeScript', 'JavaScript',
    'GitHub', 'Docker', 'Linux', 'AWS', 'Google Cloud', 'machine learning',
    'data science', 'business intelligence', 'data visualization',
    'data pipeline', 'data warehouse', 'data lake', 'feature engineering',
    'regression', 'classification', 'clustering', 'random forest', 'XGBoost',
    'time series', 'A/B testing', 'large language model', 'LLM',
    'natural language processing', 'NLP', 'generative AI'
  ],
  assistantAndDailyLife: [
    'Hi, Even', 'Even G2', 'ChatGPT', 'OpenAI', 'Claude', 'Codex',
    '退下吧', '再见',
    'Google Calendar', 'Apple Calendar', 'Google Maps', 'Google Routes',
    'calendar invite', 'meeting invite', 'appointment', 'reminder',
    'schedule', 'reschedule', 'cancel the event', 'send the email',
    'attachment', 'to-do list', 'grocery list', 'pickup', 'delivery',
    'directions', 'route', 'traffic', 'parking lot', 'pharmacy', 'weather',
    'air quality', 'pollen', 'deployment date', 'next Friday', 'refresh data'
  ]
} as const;

export const SONIOX_STT_TERMS = [...new Set(Object.values(STT_VOCABULARY).flat())];

// Keep the rollback provider's smaller keyword list focused on the most likely
// mixed-language entities. Soniox remains the default and receives the full
// structured vocabulary above.
export const OPENAI_STT_KEYWORDS = [
  'Even G2', 'Des Moines', 'West Des Moines', 'Waukee', 'Ames', 'Target',
  'Costco', 'Whole Foods Market', 'Hy-Vee', 'UPS', 'USPS', 'Power BI', 'SAS',
  'Python', 'SQL', 'TypeScript', 'Google Calendar', 'Google Maps', 'OpenAI'
] as const;
