import "dotenv/config";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { createTool } from "@mastra/core/tools";
import chalk from "chalk";

const openaiProvider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const braveSearchTool = createTool({
  id: "brave-search",
  description: "Search the web for information about a location",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    startDate: z
      .string()
      .optional()
      .describe("Start date of the trip (YYYY-MM-DD)"),
    endDate: z
      .string()
      .optional()
      .describe("End date of the trip (YYYY-MM-DD)"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        url: z.string(),
      })
    ),
  }),
  execute: async ({ context }) => {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY as string;

    let searchQuery = context.query;
    if (context.startDate && context.endDate) {
      searchQuery += ` events from ${context.startDate} to ${context.endDate}`;
    }

    const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      searchQuery
    )}&count=5`;

    const response = await fetch(searchUrl, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave Search API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      results:
        data.web?.results.map((result: any) => ({
          title: result.title,
          description: result.description,
          url: result.url,
        })) || [],
    };
  },
});

const agent = new Agent({
  name: "Travel Planner",
  instructions: `
You are a travel expert who creates practical day-by-day itineraries.

Use the brave-search tool FIRST to find information about:
1. Local attractions and activities
2. Special events, festivals, or seasonal activities happening during the specified dates (particularly major local festivals like Loy Krathong in Thailand)
3. Restaurants and accommodations appropriate for the budget level
4. Best time to visit this destination and whether the planned dates are optimal

Always perform these searches before creating the itinerary:
- "[location] festivals [month/year of trip]" (e.g., "Bangkok festivals November 2025")
- "[location] events [trip dates]" 
- "best time to visit [location]"

THEN create one single complete itinerary. Do not show your initial draft - only show the final version.

Start the itinerary with:
1. DESTINATION OVERVIEW: Brief introduction to the location
2. BEST TIME TO VISIT: Information about optimal seasons and whether the planned dates are good
3. SPECIAL EVENTS/FESTIVALS: Any notable celebrations during the stay

For each day, include:

DAY X: YYYY-MM-DD

WEATHER: Brief weather summary with temperature and conditions (if provided, otherwise skip)

BREAKFAST: Suggest one local breakfast spot with brief description

MORNING: One or two activities based on weather, with times and locations

LUNCH: Suggest one local eatery with brief description

AFTERNOON: One or two activities based on weather, with times and locations

DINNER: Suggest one local restaurant with brief description

EVENING: Optional evening activity if appropriate

Prioritize any special events, festivals or performances happening on specific dates.

If the itinerary is multi-day, include ACCOMMODATION recommendations at the end. Provide options for different budget levels (Budget, Mid-range, Luxury).

Adapt all recommendations to match the user's specified budget preference if provided.
Keep all suggestions concise and practical. Adapt recommendations based on weather conditions.
Do not include search result notes at the end of your response.
`,
  model: openaiProvider("meta-llama/Llama-3.3-70B-Instruct-Turbo"),
  tools: { braveSearchTool },
});

const fetchWeather = new Step({
  id: "fetch-weather",
  description: "Fetches weather forecast for a given city and date range",
  inputSchema: z.object({
    city: z.string().describe("The city to get the weather for"),
    startDate: z.string().describe("Start date in YYYY-MM-DD format"),
    endDate: z.string().describe("End date in YYYY-MM-DD format"),
    budget: z.enum(["budget", "mid-range", "luxury"]).default("mid-range"),
  }),
  execute: async ({ context }) => {
    const triggerData = context?.getStepResult<{
      city: string;
      startDate: string;
      endDate: string;
      budget: string;
    }>("trigger");

    if (!triggerData) {
      throw new Error("Trigger data not found");
    }

    // Calculate number of days
    const start = new Date(triggerData.startDate);
    const end = new Date(triggerData.endDate);
    const days =
      Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      triggerData.city
    )}&count=1`;
    const geocodingResponse = await fetch(geocodingUrl);
    const geocodingData = await geocodingResponse.json();

    if (!geocodingData.results?.[0]) {
      throw new Error(`Location '${triggerData.city}' not found`);
    }

    const { latitude, longitude, name } = geocodingData.results[0];

    // Fetch historical data for the next 16 days (max supported by the API)
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_mean,weathercode&timezone=auto`;
    const response = await fetch(weatherUrl);
    const data = await response.json();

    if (!data.daily || !data.daily.time) {
      console.log(
        chalk.red(
          "Weather API didn't return expected data structure - continuing without weather data"
        )
      );
      return {
        forecast: [],
        location: name,
        startDate: triggerData.startDate,
        endDate: triggerData.endDate,
        days,
        budget: triggerData.budget,
        weatherAvailable: false,
      };
    }

    // Filter to the requested date range
    let forecast: Array<{
      date: string;
      maxTemp: number;
      minTemp: number;
      precipitationChance: number;
      condition: string;
      location: string;
    }> = [];

    const dateStart = new Date(triggerData.startDate);
    const dateEnd = new Date(triggerData.endDate);

    for (let i = 0; i < data.daily.time.length; i++) {
      const currentDate = new Date(data.daily.time[i]);

      if (currentDate >= dateStart && currentDate <= dateEnd) {
        forecast.push({
          date: data.daily.time[i],
          maxTemp: data.daily.temperature_2m_max[i],
          minTemp: data.daily.temperature_2m_min[i],
          precipitationChance: data.daily.precipitation_probability_mean[i],
          condition: getWeatherCondition(data.daily.weathercode[i]),
          location: name,
        });
      }
    }

    if (forecast.length === 0) {
      console.log(
        chalk.yellow(
          "No weather data available for the specified date range - continuing without weather data"
        )
      );
      return {
        forecast: [],
        location: name,
        startDate: triggerData.startDate,
        endDate: triggerData.endDate,
        days,
        budget: triggerData.budget,
        weatherAvailable: false,
      };
    }

    console.log(chalk.green("✓ Weather data fetched successfully"));
    return {
      forecast,
      location: name,
      startDate: triggerData.startDate,
      endDate: triggerData.endDate,
      days,
      budget: triggerData.budget,
      weatherAvailable: true,
    };
  },
});

const forecastSchema = z.object({
  forecast: z.array(
    z.object({
      date: z.string(),
      maxTemp: z.number(),
      minTemp: z.number(),
      precipitationChance: z.number(),
      condition: z.string(),
      location: z.string(),
    })
  ),
  location: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  days: z.number(),
  budget: z.enum(["budget", "mid-range", "luxury"]),
  weatherAvailable: z.boolean().optional(),
});

const planItinerary = new Step({
  id: "plan-itinerary",
  description:
    "Creates a travel itinerary with activities and food recommendations",
  inputSchema: forecastSchema,
  execute: async ({ context }) => {
    const data =
      context?.getStepResult<z.infer<typeof forecastSchema>>("fetch-weather");

    if (!data) {
      throw new Error("Forecast data not found");
    }

    const {
      forecast,
      location,
      startDate,
      endDate,
      days,
      budget,
      weatherAvailable,
    } = data;

    // Extract month and year for festival search
    const tripDate = new Date(startDate);
    const month = tripDate.toLocaleString("en-US", { month: "long" });
    const year = tripDate.getFullYear();

    console.log(
      chalk.blue.bold(`\n📍 Planning itinerary for ${chalk.white(location)}`)
    );
    console.log(
      chalk.blue(
        `🗓️  Dates: ${chalk.white(startDate)} to ${chalk.white(
          endDate
        )} (${chalk.white(days)} days)`
      )
    );
    console.log(chalk.blue(`💰 Budget: ${chalk.white(budget)}\n`));

    let prompt;

    if (weatherAvailable === false || forecast.length === 0) {
      prompt = `Create a ${days}-day itinerary for ${location} from ${startDate} to ${endDate}. 

Budget preference: ${budget}

First, search for:
1. "${location} festivals ${month} ${year}" to find any local festivals or events
2. "${location} events ${startDate} to ${endDate}" to find current happenings
3. "best time to visit ${location}" to determine if these dates are optimal

Include this information at the beginning of the itinerary:
- Brief destination overview
- Best time to visit information and whether the planned dates are good
- Any special events or festivals happening during the stay (especially major festivals)

Then for each day, include breakfast, lunch, and dinner recommendations along with morning and afternoon activities. If more than 1 day, include accommodation options.

Weather data is not available for the requested dates. Skip weather information in the itinerary.`;
    } else {
      prompt = `Create a ${days}-day itinerary for ${location} from ${startDate} to ${endDate} based on this weather forecast:
${JSON.stringify(forecast, null, 2)}

Budget preference: ${budget}

First, search for:
1. "${location} festivals ${month} ${year}" to find any local festivals or events
2. "${location} events ${startDate} to ${endDate}" to find current happenings
3. "best time to visit ${location}" to determine if these dates are optimal

Include this information at the beginning of the itinerary:
- Brief destination overview
- Best time to visit information and whether the planned dates are good
- Any special events or festivals happening during the stay (especially major festivals)

Then for each day, include breakfast, lunch, and dinner recommendations along with morning and afternoon activities. If more than 1 day, include accommodation options.`;
    }

    console.log(chalk.yellow("🔍 Searching for destination information..."));
    const response = await agent.stream([
      {
        role: "user",
        content: prompt,
      },
    ]);

    let itineraryText = "";
    console.log(chalk.green.bold("\n✏️  Generating Itinerary:\n"));

    for await (const chunk of response.textStream) {
      process.stdout.write(chalk.cyan(chunk));
      itineraryText += chunk;
    }

    return {
      itinerary: itineraryText,
      location,
      startDate,
      endDate,
      days,
      budget,
    };
  },
});

function getWeatherCondition(code: number): string {
  const conditions: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    95: "Thunderstorm",
  };
  return conditions[code] || "Unknown";
}

const itineraryWorkflow = new Workflow({
  name: "itineraryWorkflow",
  triggerSchema: z.object({
    city: z.string().describe("The city to get the weather for"),
    startDate: z.string().describe("Start date in YYYY-MM-DD format"),
    endDate: z.string().describe("End date in YYYY-MM-DD format"),
    budget: z
      .enum(["budget", "mid-range", "luxury"])
      .default("mid-range")
      .describe("Budget preference for accommodations and activities"),
  }),
})
  .step(fetchWeather)
  .then(planItinerary);

itineraryWorkflow.commit();

const mastra = new Mastra({
  workflows: {
    itineraryWorkflow,
  },
});

async function main() {
  console.log(chalk.green.bold("\n🌴 TRAVEL ITINERARY GENERATOR 🌴"));
  console.log(chalk.green("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

  const { start } = mastra.getWorkflow("itineraryWorkflow").createRun();

  console.log(chalk.yellow("⚙️  Initializing workflow..."));

  const workflowResult = await start({
    triggerData: {
      city: "Alor Setar",
      startDate: "2025-11-04",
      endDate: "2025-11-05",
      budget: "mid-range",
    },
  });

  // Access the final step's output (plan-itinerary)
  //@ts-ignore
  const result = workflowResult.results["plan-itinerary"].output;

  console.log("\n");
  console.log(chalk.magenta.bold("✨ ITINERARY GENERATED SUCCESSFULLY ✨"));
  console.log(chalk.magenta("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(
    `${chalk.blue.bold("Location:")} ${chalk.white(result.location)}`
  );
  console.log(
    `${chalk.blue.bold("Dates:")} ${chalk.white(
      `${result.startDate} to ${result.endDate}`
    )}`
  );
  console.log(
    `${chalk.blue.bold("Duration:")} ${chalk.white(`${result.days} days`)}`
  );
  console.log(`${chalk.blue.bold("Budget:")} ${chalk.white(result.budget)}`);
  console.log("\n");
}

main();
