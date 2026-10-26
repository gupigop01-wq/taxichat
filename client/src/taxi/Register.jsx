import { useEffect, useState } from "react";
import * as Yup from "yup";
import { Formik, Form } from "formik";
import { useDispatch } from "react-redux";
import FormField from "./FormField";
import Spinner from "./Spinner";
import { useAuthRequest } from "./authRequest";
import { withRussianPrefix } from "./phone";
import { authActions } from "../store/authSlice";
import { IconText } from "./TaxiIcon";

const schema = Yup.object().shape({
  name: Yup.string()
    .min(1, "Слишком коротко")
    .max(50, "Слишком длинно")
    .required("Обязательное поле"),
  username: Yup.string()
    .min(3, "Минимум 3 символа")
    .max(30, "Слишком длинно")
    .required("Обязательное поле"),
  phone: Yup.string()
    .required("Укажите телефон")
    .test("phone", "Формат: +7 902 111-22-33 или 89021112233", (value) => {
      if (!value) return false;
      const digits = value.replace(/\D/g, "");
      // 10 digits are completed with 7 by withRussianPrefix, 11 must start 7/8
      return digits.length === 10 || (digits.length === 11 && /^[78]/.test(digits));
    }),
  password: Yup.string().min(8, "Минимум 8 символов").required("Обязательное поле"),
  confirmPassword: Yup.string()
    .required("Обязательное поле")
    .oneOf([Yup.ref("password"), null], "Пароли не совпадают"),
});

const Register = ({ setUserWantsToLogin }) => {
  const dispatch = useDispatch();
  const [formError, setFormError] = useState(null);
  const [cities, setCities] = useState([]);
  const [cityMode, setCityMode] = useState("pick"); // pick | custom
  const { state, run } = useAuthRequest();

  useEffect(() => {
    fetch("/api/geo/cities", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => setCities(data.data?.cities ?? []))
      .catch(() => setCities([]));
  }, []);

  return (
    <div className="w-full anim-rise">
      <div className="flex flex-col items-center gap-1 mb-6">
        <span className="brand-title brand-gradient">Бомбила</span>
        <span className="text-[1.2rem] text-secondary-text tracking-wide text-center">
          Заказ такси через чат. Выберите свой город — он понадобится для заказов.
        </span>
      </div>

      <div className="glass-strong rounded-3xl p-5 space-y-4">
        <div className="text-center font-display font-bold text-[1.6rem]"><IconText>🪪 Регистрация</IconText></div>
        <Formik
          initialValues={{
            name: "",
            username: "",
            phone: "",
            password: "",
            confirmPassword: "",
            cityId: "",
            newCityName: "",
          }}
          validationSchema={schema}
          onSubmit={async (values) => {
            setFormError(null);
            const payload = {
              name: values.name,
              username: values.username,
              phone: withRussianPrefix(values.phone),
              password: values.password,
              confirmPassword: values.confirmPassword,
              ...(cityMode === "pick" && values.cityId
                ? { cityId: values.cityId }
                : {
                    newCityName: values.newCityName,
                    // A city added manually has no region yet: the device zone
                    // is the only reliable hint about its clock
                    newCityTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  }),
            };
            try {
              await run("/api/user/register", payload);
              dispatch(authActions.login());
            } catch (error) {
              setFormError(error.message ?? "Не удалось создать аккаунт");
            }
          }}
        >
          {({ errors, values, setFieldValue }) => (
            <Form className="flex flex-col gap-[1.5rem]" autoComplete="off">
              {formError && (
                <div role="alert" className="text-[1.3rem] text-danger text-center bg-danger/10 border border-danger/40 rounded-xl py-2 px-3">
                  {formError}
                </div>
              )}
              <FormField
                center
                persistentLabel
                labelName="Имя"
                labelClassName="bg-[#171717]"
                name="name"
                required
                value={values.name}
                error={errors.name}
              />

              <FormField
                center
                persistentLabel
                labelName="Логин"
                labelClassName="bg-[#171717]"
                name="username"
                required
                value={values.username}
                error={errors.username}
              />

              <FormField
                center
                persistentLabel
                labelName="Телефон"
                labelClassName="bg-[#171717]"
                name="phone"
                required
                type="tel"
                value={values.phone}
                error={errors.phone}
              />

              <FormField
                center
                persistentLabel
                labelName="Пароль"
                labelClassName="bg-[#171717]"
                name="password"
                required
                value={values.password}
                error={errors.password}
                fieldType="password"
              />

              <FormField
                center
                persistentLabel
                labelName="Повторите пароль"
                labelClassName="bg-[#171717]"
                name="confirmPassword"
                required
                value={values.confirmPassword}
                error={errors.confirmPassword}
                fieldType="password"
              />

              <div className="flex flex-wrap gap-2 justify-center text-sm" role="group" aria-label="Способ выбора города">
                <button
                  type="button"
                  aria-pressed={cityMode === "pick"}
                  className={`press px-3 py-1.5 rounded-xl ${
                    cityMode === "pick" ? "btn-accent font-semibold" : "glass text-secondary-text"
                  }`}
                  onClick={() => setCityMode("pick")}
                >
                  Выбрать город
                </button>
                <button
                  type="button"
                  aria-pressed={cityMode === "custom"}
                  className={`press px-3 py-1.5 rounded-xl ${
                    cityMode === "custom" ? "btn-accent font-semibold" : "glass text-secondary-text"
                  }`}
                  onClick={() => setCityMode("custom")}
                >
                  Моего города нет
                </button>
              </div>

              {cityMode === "pick" ? (
                <div>
                  <label htmlFor="cityId" className="block text-secondary-text text-sm mb-1">Город</label>
                  <select
                    id="cityId"
                    className="w-full bg-[#0d0d0d] text-white border border-secondary-text/30 rounded-2xl p-3 text-[1.5rem] focus:border-accent focus:outline-none"
                    name="cityId"
                    value={values.cityId}
                    onChange={(event) => setFieldValue("cityId", event.target.value)}
                  >
                    <option value="">Выберите город</option>
                    {cities.map((city) => (
                      <option key={city._id} value={city._id}>
                        {city.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <FormField
                  center
                  persistentLabel
                  labelName="Ваш город"
                  labelClassName="bg-[#171717]"
                  name="newCityName"
                  value={values.newCityName}
                  error={errors.newCityName}
                />
              )}

              <button
                className={`press btn-accent p-[1.2rem] rounded-2xl font-display font-extrabold text-[1.5rem] flex items-center justify-center w-full tracking-wide ${
                  state === "loading" ||
                  (cityMode === "pick" ? !values.cityId : !values.newCityName)
                    ? "opacity-50"
                    : "opacity-100"
                }`}
                type="submit"
                disabled={state === "loading" || (cityMode === "pick" ? !values.cityId : !values.newCityName)}
                aria-busy={state === "loading"}
              >
                {state !== "loading" && "Создать аккаунт"}
                {state === "loading" && <Spinner className="w-[2.5rem] h-[2.5rem]" />}
              </button>
            </Form>
          )}
        </Formik>
      </div>

      <button
        onClick={() => setUserWantsToLogin(true)}
        className="mt-[2rem] w-full text-center text-secondary-text underline hover:text-cta-icon text-[1.4rem]"
      >
        Уже есть аккаунт? Войти
      </button>
    </div>
  );
};

export default Register;
