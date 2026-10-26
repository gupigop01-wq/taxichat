import { useId } from "react";
import { Field } from "formik";

// Form field of the login / registration screens. The label floats above the
// input (persistent on the auth screens) and the input is centered.
function FormField({
  labelName,
  labelClassName,
  name,
  value,
  error,
  required,
  fieldType,
  center = false,
  persistentLabel = false,
}) {
  const errorId = useId();
  const horizontal = center
    ? "left-1/2 -translate-x-1/2"
    : "left-[1.5rem] group-focus-within:left-[1rem]";

  return (
    <div className="relative group">
      <label
        htmlFor={name}
        className={`${labelClassName || ""}
        absolute 
        ${
          persistentLabel || value
            ? "text-[1.4rem] -top-[1.1rem] -translate-y-0 "
            : "top-1/2 -translate-y-1/2 text-[1.6rem]"
        } ${persistentLabel ? "" : "group-focus-within:-top-[1.1rem]"}
        group-focus-within:-translate-y-0
        ${horizontal}
        bg-primary 
        text-secondary-text group-focus-within:text-cta-icon
        px-[.3rem] 
        duration-200
        group-focus-within:text-[1.4rem]
        `}
      >
        {labelName}
        {required && <span className="text-cta-icon"> *</span>}
      </label>
      <Field
        name={name}
        id={name}
        required={required}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`bg-transparent border border-secondary-text rounded-2xl py-[1rem] group-focus-within:outline-none px-[1.5rem] focus-within:border-2 focus-within:border-cta-icon w-full ${
          center ? "text-center" : ""
        }`}
        type={fieldType ? fieldType : "text"}
      />
      {error && (
        <div id={errorId} className="mt-1 text-[1.2rem] text-danger text-center">{error}</div>
      )}
    </div>
  );
}

export default FormField;
