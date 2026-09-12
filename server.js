const express =
  require("express");

const db =
  require("./db/database");

const {
  serveMeal,
  getCurrentMeal
} = require(
  "./services/meal-service"
);

const app =
  express();

app.use(
  express.json()
);

const PORT =
  process.env.PORT || 4000;


/*
|--------------------------------------------------------------------------
| Gateway Health
|--------------------------------------------------------------------------
*/

app.get(
  "/health",
  (req, res) => {

    res.json({

      status: "ok",

      gateway:
        "Mess Local Gateway",

      database:
        "SQLite",

      currentMeal:
        getCurrentMeal()

    });

  }
);


/*
|--------------------------------------------------------------------------
| Employees
|--------------------------------------------------------------------------
*/

app.get(
  "/employees",
  (req, res) => {

    const employees =
      db.prepare(`
        SELECT
          id,
          employee_code,
          name,
          qr_code,
          face_device_user_id,
          mess_eligible,
          monthly_allowance,
          available_balance,
          active

        FROM employees

        WHERE active = 1
      `).all();

    res.json(
      employees
    );

  }
);


/*
|--------------------------------------------------------------------------
| Transactions
|--------------------------------------------------------------------------
*/

app.get(
  "/transactions",
  (req, res) => {

    const transactions =
      db.prepare(`
        SELECT *
        FROM transactions
        ORDER BY transaction_time DESC
      `).all();

    res.json(
      transactions
    );

  }
);


/*
|--------------------------------------------------------------------------
| Pending Sync Queue
|--------------------------------------------------------------------------
*/

app.get(
  "/sync/pending",
  (req, res) => {

    const pending =
      db.prepare(`
        SELECT *
        FROM sync_queue
        WHERE status = 'pending'
        ORDER BY id ASC
      `).all();

    res.json(
      pending
    );

  }
);


/*
|--------------------------------------------------------------------------
| Serve Meal
|--------------------------------------------------------------------------
*/

app.post(
  "/api/meal/serve",
  (req, res) => {

    const {

      identifier,
      method,
      deviceId

    } = req.body;

    if (!identifier) {

      return res
        .status(400)
        .json({

          success: false,

          message:
            "identifier is required."

        });

    }

    if (
      ![
        "qr",
        "face",
        "manual"
      ].includes(method)
    ) {

      return res
        .status(400)
        .json({

          success: false,

          message:
            "method must be qr, face or manual."

        });

    }

    const result =
      serveMeal({

        identifier,
        method,
        deviceId

      });

    if (!result.success) {

      return res
        .status(400)
        .json(
          result
        );

    }

    res.json(
      result
    );

  }
);


app.listen(
  PORT,
  () => {

    console.log(
      `✅ Mess Local Gateway running on http://localhost:${PORT}`
    );

  }
);